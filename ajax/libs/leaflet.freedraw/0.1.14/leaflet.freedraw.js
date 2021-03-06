(function($window, L, d3) {

    "use strict";

    /**
     * @method throwException
     * @param message {String}
     * @param path {String}
     * @return {void}
     */
    var throwException = function throwException(message, path) {

        if (path) {

            // Output a link for a more informative message in the EXCEPTIONS.md.
            console.error('See: https://github.com/Wildhoney/Leaflet.FreeDraw/blob/master/EXCEPTIONS.md#' + path);
        }

        // ..And then output the thrown exception.
        throw "Leaflet.FreeDraw: " + message + ".";

    };

    /**
     * @method freeDraw
     * @param options {Object}
     * @returns {window.L.FreeDraw}
     */
    L.freeDraw = function freeDraw(options) {
        return new L.FreeDraw(options);
    };

    L.FreeDraw = L.FeatureGroup.extend({

        /**
         * @property map
         * @type {L.Map|null}
         */
        map: null,

        /**
         * @property svg
         * @type {Object}
         */
        svg: {},

        /**
         * Determines whether the user is currently creating a polygon.
         *
         * @property creating
         * @type {Boolean}
         */
        creating: false,

        /**
         * Responsible for holding the line function that is required by D3 to draw the line based
         * on the user's cursor position.
         *
         * @property lineFunction
         * @type {Function}
         */
        lineFunction: function () {},

        /**
         * Responsible for holding an array of latitudinal and longitudinal points for generating
         * the polygon.
         *
         * @property latLngs
         * @type {Array}
         */
        latLngs: [],

        /**
         * @property options
         * @type {Object}
         */
        options: {},

        /**
         * @property markers
         * @type {L.LayerGroup|null}
         */
        markerLayer: L.layerGroup(),

        /**
         * @property hull
         * @type {Object}
         */
        hull: {},

        /**
         * @property edges
         * @type {Array}
         */
        edges: [],

        /**
         * @property mode
         * @type {Number}
         */
        mode: 1,

        /**
         * Responsible for holding the coordinates of the user's last cursor position for drawing
         * the D3 polygon tracing the user's cursor.
         *
         * @property fromPoint
         * @type {Object}
         */
        fromPoint: { x: 0, y: 0 },

        /**
         * @property movingEdge
         * @type {L.polygon|null}
         */
        movingEdge: null,

        /**
         * Responsible for knowing whether a boundary update should be propagated once the user exits
         * the editing mode.
         *
         * @property boundaryUpdateRequired
         * @type {Boolean}
         */
        boundaryUpdateRequired: false,

        /**
         * @method initialize
         * @param options {Object}
         * @return {void}
         */
        initialize: function initialize(options) {

            L.Util.setOptions(this, options);

            this.options = new L.FreeDraw.Options();
            this.hull    = new L.FreeDraw.Hull();

            this.setMode(options.mode || this.mode);

        },

        /**
         * @method onAdd
         * @param map {L.Map}
         * @return {void}
         */
        onAdd: function onAdd(map) {

            // Lazily hook up the options and hull objects.
            this.map  = map;
            this.mode = this.mode || L.FreeDraw.MODES.VIEW;

            // Define the line function for drawing the polygon from the user's mouse pointer.
            this.lineFunction = d3.svg.line()
                                  .x(function pointX(d) { return d.x; })
                                  .y(function pointY(d) { return d.y; })
                                  .interpolate('linear');

            // Create a new instance of the D3 free-hand tracer.
            this.createD3();

            // Attach all of the events.
            this._attachMouseDown();
            this._attachMouseMove();
            this._attachMouseUpLeave();

            // Set the default mode.
            this.setMode(this.mode);

        },

        /**
         * @method onRemove
         * @return {void}
         */
        onRemove: function onRemove() {
            this.clearPolygons();
        },

        /**
         * @method setMode
         * @param mode {Number}
         * @return {void}
         */
        setMode: function setMode(mode) {

            var isCreate = !!(mode & L.FreeDraw.MODES.CREATE),
                method   = !isCreate ? 'enable' : 'disable';

            // Set the current mode.
            this.mode = mode;

            if (!this.map) {
                return;
            }

            if (this.boundaryUpdateRequired && !(this.mode & L.FreeDraw.MODES.EDIT)) {

                // Share the boundaries if there's an update available and the user is changing the mode
                // to anything else but the edit mode again.
                this.notifyBoundaries();
                this.boundaryUpdateRequired = false;

            }

            // Update the permissions for what the user can do on the map.
            this.map.dragging[method]();
            this.map.touchZoom[method]();
            this.map.doubleClickZoom[method]();
            this.map.scrollWheelZoom[method]();

            /**
             * Responsible for applying the necessary classes to the map based on the
             * current active modes.
             *
             * @method defineClasses
             * @return {void}
             */
            (function defineClasses(modes, classList) {

                classList.remove('mode-create');
                classList.remove('mode-edit');
                classList.remove('mode-delete');
                classList.remove('mode-view');

                if (mode & modes.CREATE) {
                    classList.add('mode-create');
                }

                if (mode & modes.EDIT) {
                    classList.add('mode-edit');
                }

                if (mode & modes.DELETE) {
                    classList.add('mode-delete');
                }

                if (mode & modes.VIEW) {
                    classList.add('mode-view');
                }

            }(L.FreeDraw.MODES, this.map._container.classList));

        },

        /**
         * @method createD3
         * @return {void}
         */
        createD3: function createD3() {
            this.svg = d3.select('body').append('svg').attr('class', this.options.svgClassName)
                         .attr('width', 200).attr('height', 200);
        },

        /**
         * @method destroyD3
         * @return {L.FreeDraw}
         * @chainable
         */
        destroyD3: function destroyD3() {
            this.svg.remove();
            this.svg = {};
            return this;
        },

        /**
         * @method createPolygon
         * @param latLngs {L.latLng[]}
         * @return {L.polygon}
         */
        createPolygon: function createPolygon(latLngs) {

            // Begin to create a brand-new polygon.
            this.destroyD3().createD3();

            var polygon = L.polygon(latLngs, {
                color: '#D7217E',
                weight: 0,
                fill: true,
                fillColor: '#D7217E',
                fillOpacity: 0.75,
                smoothFactor: this.options.smoothFactor
            });

            // Add the polyline to the map, and then find the edges of the polygon.
            polygon.addTo(this.map);
            polygon._latlngs = [];
            this.attachEdges(polygon);

            polygon._parts[0].forEach(function forEach(edge) {

                // Iterate over all of the parts to update the latLngs to clobber the redrawing upon zooming.
                polygon._latlngs.push(this.map.containerPointToLatLng(edge));

            }.bind(this));

            this.notifyBoundaries();
            return polygon;

        },

        /**
         * @method destroyPolygon
         * @param polygon {Object}
         * @return {void}
         */
        destroyPolygon: function destroyPolygon(polygon) {

            // Remove the shape.
            polygon._container.remove();

            // ...And then remove all of its related edges to prevent memory leaks.
            this.edges = this.edges.filter(function filter(edge) {

                if (edge._polygon !== polygon) {
                    return true;
                }

                // Physically remove the edge from the DOM.
                edge._icon.remove();

            });

            this.notifyBoundaries();

        },

        /**
         * @method clearPolygons
         * @return {void}
         */
        clearPolygons: function clearPolygons() {

            this.edges.forEach(function forEach(edge) {

                // Iteratively remove each polygon in the DOM.
                this.destroyPolygon(edge._polygon);

            }.bind(this));

            this.notifyBoundaries();

        },

        /**
         * @method notifyBoundaries
         * @return {void}
         */
        notifyBoundaries: function notifyBoundaries() {

            var latLngs = [],
                last    = null,
                index   = -1;

            this.edges.forEach(function forEach(edge) {

                if (edge._polygonId !== last) {
                    index++;
                }

                if (typeof latLngs[index] === 'undefined') {

                    // Create the array entry point if it hasn't yet been defined.
                    latLngs[index] = [];

                }

                last = edge._polygonId;
                latLngs[index].push(edge['_latlng']);

            }.bind(this));

            // Invoke the user passed method for specifying latitude/longitudes.
            this.options.markersFn(latLngs, this.setMarkers.bind(this));

        },

        /**
         * @method setMarkers
         * @param markers {L.Marker[]}
         * @param divIcon {L.DivIcon}
         * @return {void}
         */
        setMarkers: function setMarkers(markers, divIcon) {

            if (typeof divIcon !== 'undefined' && !(divIcon instanceof L.DivIcon)) {

                // Ensure if the user has passed a second argument that it is a valid DIV icon.
                throwException('Second argument must be an instance of L.DivIcon');

            }

            // Reset the markers collection.
            this.map.removeLayer(this.markerLayer);
            this.markerLayer = L.layerGroup();
            this.markerLayer.addTo(this.map);

            if (!markers || markers.length === 0) {
                return;
            }

            var options = divIcon ? { icon: divIcon } : {};

            // Iterate over each marker to plot it on the map.
            for (var addIndex = 0, addLength = markers.length; addIndex < addLength; addIndex++) {

                if (!(markers[addIndex] instanceof L.LatLng)) {
                    throwException('Supplied markers must be instances of L.LatLng');
                }

                // Add the marker using the custom DIV icon if it has been specified.
                var marker = L.marker(markers[addIndex], options);
                this.markerLayer.addLayer(marker);

            }

        },

        /**
         * @method attachEdges
         * @param polygon {L.polygon}
         * @return {void}
         */
        attachEdges: function attachEdges(polygon) {

            // Extract the parts from the polygon.
            var parts = polygon._parts[0];

            parts.forEach(function forEach(point, index) {

                // Leaflet creates elbows in the polygon, which we need to utilise to add the
                // points for modifying its shape.
                var edge   = L.divIcon({ className: this.options.iconClassName }),
                    latLng = this.map.layerPointToLatLng(point);

                edge = L.marker(latLng, { icon: edge }).addTo(this.map);

                // Marker requires instances so that it can modify its shape.
                edge._polygon   = polygon;
                edge._polygonId = polygon['_leaflet_id'];
                edge._index     = index;
                edge._length    = parts.length;
                this.edges.push(edge);

                edge.on('mousedown', function onMouseDown(event) {
                    event.originalEvent.preventDefault();
                    event.originalEvent.stopPropagation();
                    this.movingEdge = event.target;
                }.bind(this));

            }.bind(this));

        },

        updatePolygonEdge: function updatePolygon(edge, posX, posY) {

            var updatedLatLng = this.map.containerPointToLatLng(L.point(posX, posY));
            edge.setLatLng(updatedLatLng);

            // Fetch all of the edges in the group based on the polygon.
            var edges = this.edges.filter(function filter(marker) {
                return marker._polygon === edge._polygon;
            });

            var updatedLatLngs = [];
            edges.forEach(function forEach(marker) {
                updatedLatLngs.push(marker.getLatLng());
            });

            // Update the latitude and longitude values.
            edge._polygon.setLatLngs(updatedLatLngs);
            edge._polygon.redraw();

        },

        /**
         * @method _attachMouseDown
         * @return {void}
         * @private
         */
        _attachMouseDown: function _attachMouseDown() {

            this.map.on('mousedown', function onMouseDown(event) {

                /**
                 * Used for determining if the user clicked with the right mouse button.
                 *
                 * @constant RIGHT_CLICK
                 * @type {Number}
                 */
                var RIGHT_CLICK = 2;

                if (event.originalEvent.button === RIGHT_CLICK) {
                    return;
                }

                if (!this.options.multiplePolygons && this.edges.length) {

                    // User is only allowed to create one polygon.
                    return;

                }

                var originalEvent = event.originalEvent;

                originalEvent.stopPropagation();
                originalEvent.preventDefault();

                this.latLngs   = [];
                this.fromPoint = { x: originalEvent.clientX, y: originalEvent.clientY };

                if (this.mode & L.FreeDraw.MODES.CREATE) {

                    // Place the user in create polygon mode.
                    this.creating = true;

                }

            }.bind(this));

        },

        /**
         * @method _attachMouseMove
         * @return {void}
         * @private
         */
        _attachMouseMove: function _attachMouseMove() {

            this.map.on('mousemove', function onMouseMove(event) {

                var originalEvent = event.originalEvent;

                if (this.movingEdge) {

                    // User is in fact modifying the shape of the polygon.
                    this._editMouseMove(originalEvent);
                    return;

                }

                if (!this.creating) {

                    // We can't do anything else if the user is not in the process of creating a brand-new
                    // polygon.
                    return;

                }

                this._createMouseMove(originalEvent);

            }.bind(this));

        },

        /**
         * @method _editMouseMove
         * @param event {Object}
         * @return {void}
         * @private
         */
        _editMouseMove: function _editMouseMove(event) {

            var pointModel = L.point(event.clientX, event.clientY);

            // Modify the position of the marker on the map based on the user's mouse position.
            var styleDeclaration = this.movingEdge._icon.style;
            styleDeclaration[L.DomUtil.TRANSFORM] = pointModel;

            // Update the polygon's shape in real-time as the user drags their cursor.
            this.updatePolygonEdge(this.movingEdge, pointModel.x, pointModel.y);

        },

        /**
         * @method _attachMouseUpLeave
         * @return {void}
         * @private
         */
        _attachMouseUpLeave: function _attachMouseUpLeave() {

            this.map.on('mouseup mouseout mouseleave', function onMouseUpAndMouseLeave() {

                if (this.movingEdge) {

                    if (!this.options.boundariesAfterEdit) {

                        // Notify of a boundary update immediately after editing one edge.
                        this.notifyBoundaries();

                    } else {

                        // Change the option so that the boundaries will be invoked once the edit mode
                        // has been exited.
                        this.boundaryUpdateRequired = true;

                    }

                    this.movingEdge = null;
                    return;

                }

                this._createMouseUp();

            }.bind(this));

        },

        /**
         * @method _createMouseMove
         * @param event {Object}
         * @return {void}
         * @private
         */
        _createMouseMove: function _createMouseMove(event) {

            // Grab the cursor's position from the event object.
            var pointerX = event.clientX,
                pointerY = event.clientY;

            // Resolve the pixel point to the latitudinal and longitudinal equivalent.
            var point = L.point(pointerX, pointerY),
                latLng = this.map.containerPointToLatLng(point);

            // Line data that is fed into the D3 line function we defined earlier.
            var lineData = [this.fromPoint, { x: pointerX, y: pointerY }];

            // Draw SVG line based on the last movement of the mouse's position.
            this.svg.append('path').attr('d', this.lineFunction(lineData))
                .attr('stroke', '#D7217E').attr('stroke-width', 2).attr('fill', 'none');

            // Take the pointer's position from the event for the next invocation of the mouse move event,
            // and store the resolved latitudinal and longitudinal values.
            this.fromPoint.x = pointerX;
            this.fromPoint.y = pointerY;
            this.latLngs.push(latLng);

        },

        /**
         * @method _createMouseUp
         * @return {void}
         * @private
         */
        _createMouseUp: function _createMouseUp() {

            // User has finished creating their polygon!
            this.creating = false;

            if (this.latLngs.length <= 2) {

                // User has failed to drag their cursor enough to create a valid polygon.
                return;

            }

            if (this.options.hullAlgorithm) {

                // Use the defined hull algorithm.
                this.hull.setMap(this.map);
                var latLngs = this.hull[this.options.hullAlgorithm](this.latLngs);

            }

            // Required for joining the two ends of the free-hand drawing to create a closed polygon.
            this.latLngs.push(this.latLngs[0]);

            // Physically draw the Leaflet generated polygon.
            var polygon  = this.createPolygon(latLngs || this.latLngs);
            this.latLngs = [];

            polygon.on('click', function onClick() {

                if (this.mode & L.FreeDraw.MODES.DELETE) {

                    // Remove the polygon when the user clicks on it, and they're in delete mode.
                    this.destroyPolygon(polygon);

                }

            }.bind(this));

            if (this.options.createExitMode) {

                // Automatically exit the user from the creation mode.
                this.setMode(this.mode ^ L.FreeDraw.MODES.CREATE);

            }

        }

    });

    /**
     * @constant MODES
     * @type {Object}
     */
    L.FreeDraw.MODES = {
        VIEW:   1,
        CREATE: 2,
        EDIT:   4,
        DELETE: 8,
        ALL:    1 | 2 | 4 | 8
    };

})(window, window.L, window.d3);

(function() {

    "use strict";

    /**
     * @module FreeDraw
     * @submodule Hull
     * @author Adam Timberlake
     * @link https://github.com/Wildhoney/Leaflet.FreeDraw
     * @constructor
     */
    L.FreeDraw.Hull = function FreeDrawHull() {};

    /**
     * @property prototype
     * @type {Object}
     */
    L.FreeDraw.Hull.prototype = {

        /**
         * @property map
         * @type {L.Map|Object}
         */
        map: {},

        /**
         * @method setMap
         * @param map {L.Map}
         * @return {void}
         */
        setMap: function setMap(map) {
            this.map = map;
        },

        /**
         * @link https://github.com/brian3kb/graham_scan_js
         * @method brian3kbGrahamScan
         * @param latLngs {L.LatLng[]}
         * @return {L.LatLng[]}
         */
        brian3kbGrahamScan: function brian3kbGrahamScan(latLngs) {

            var convexHull     = new ConvexHullGrahamScan(),
                resolvedPoints = [],
                points         = [],
                hullLatLngs    = [];

            latLngs.forEach(function forEach(latLng) {

                // Resolve each latitude/longitude to its respective container point.
                points.push(this.map.latLngToContainerPoint(latLng));

            }.bind(this));

            points.forEach(function forEach(point) {
                convexHull.addPoint(point.x, point.y);
            }.bind(this));

            var hullPoints = convexHull.getHull();

            hullPoints.forEach(function forEach(hullPoint) {
                resolvedPoints.push(L.point(hullPoint.x, hullPoint.y));
            }.bind(this));

            // Create an unbroken polygon.
            resolvedPoints.push(resolvedPoints[0]);

            resolvedPoints.forEach(function forEach(point) {
                hullLatLngs.push(this.map.containerPointToLatLng(point));
            }.bind(this));

            return hullLatLngs;

        },

        /**
         * @link https://github.com/Wildhoney/ConcaveHull
         * @method wildhoneyConcaveHull
         * @param latLngs {L.LatLng[]}
         * @return {L.LatLng[]}
         */
        wildhoneyConcaveHull: function wildhoneyConcaveHull(latLngs) {
            latLngs.push(latLngs[0]);
            return new ConcaveHull(latLngs).getLatLngs();
        }

    }

}());

(function() {

    "use strict";

    /**
     * @module FreeDraw
     * @submodule Options
     * @author Adam Timberlake
     * @link https://github.com/Wildhoney/Leaflet.FreeDraw
     * @constructor
     */
    L.FreeDraw.Options = function FreeDrawOptions() {};

    /**
     * @property prototype
     * @type {Object}
     */
    L.FreeDraw.Options.prototype = {

        /**
         * @property multiplePolygons
         * @type {Boolean}
         */
        multiplePolygons: true,

        /**
         * @property hullAlgorithm
         * @type {String|Boolean}
         */
        hullAlgorithm: false,

        /**
         * @property boundariesAfterEdit
         * @type {Boolean}
         */
        boundariesAfterEdit: false,

        /**
         * @property createExitMode
         * @type {Boolean}
         */
        createExitMode: true,

        /**
         * @method markersFn
         * @type {Function}
         */
        markersFn: function() {},

        /**
         * @property hullAlgorithms
         * @type {Object}
         */
        hullAlgorithms: {
            'brian3kb/graham_scan_js': 'brian3kbGrahamScan',
            'Wildhoney/ConcaveHull': 'wildhoneyConcaveHull'
        },

        /**
         * @property svgClassName
         * @type {String}
         */
        svgClassName: 'tracer',

        /**
         * @property smoothFactor
         * @type {Number}
         */
        smoothFactor: 5,

        /**
         * @property iconClassName
         * @type {String}
         */
        iconClassName: 'polygon-elbow',

        /**
         * @method exitModeAfterCreate
         * @param value {Boolean}
         * @return {void}
         */
        exitModeAfterCreate: function exitModeAfterCreate(value) {
            this.createExitMode = !!value;
        },

        /**
         * @method allowMultiplePolygons
         * @param allow {Boolean}
         * @return {void}
         */
        allowMultiplePolygons: function allowMultiplePolygons(allow) {
            this.multiplePolygons = !!allow;
        },

        /**
         * @method setSVGClassName
         * @param className {String}
         * @return {void}
         */
        setSVGClassName: function setSVGClassName(className) {
            this.svgClassName = className;
        },

        /**
         * @method setBoundariesAfterEdit
         * @param value {Boolean}
         * @return {void}
         */
        setBoundariesAfterEdit: function setBoundariesAfterEdit(value) {
            this.boundariesAfterEdit = !!value;
        },

        /**
         * @method smoothFactor
         * @param factor {Number}
         * @return {void}
         */
        setSmoothFactor: function setSmoothFactor(factor) {
            this.smoothFactor = +factor;
        },

        /**
         * @method setIconClassName
         * @param className {String}
         * @return {void}
         */
        setIconClassName: function setIconClassName(className) {
            this.iconClassName = className;
        },

        /**
         * @method getMarkers
         * @param markersFn {Function}
         * @return {void}
         */
        getMarkers: function getMarkers(markersFn) {
            this.markersFn = markersFn;
        },

        /**
         * @method setHullAlgorithm
         * @param algorithm {String|Boolean}
         * @return {void}
         */
        setHullAlgorithm: function setHullAlgorithm(algorithm) {

            if (algorithm && !this.hullAlgorithms.hasOwnProperty(algorithm)) {

                // Ensure the passed algorithm is valid.
                return;

            }

            this.hullAlgorithm = this.hullAlgorithms[algorithm];

        }

    };

})();