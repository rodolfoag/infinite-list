var Scroller = require('../vendor/zynga-scroller/Scroller.js'),
    Layer = require('./Layer'),
    LayersPool = require('./layerPool'),
    TouchScroller = require('./TouchScroller'),
    StyleHelpers = require('./StyleHelpers'),
    DEFAULT_ITEM_HEIGHT = 40,
    MIN_FPS = 30;

var InfiniteList = function (listConfig) {

    var config = {
            itemHeightGetter: null,
            itemRenderer: null,
            itemTypeGetter: null,
            pageFetcher: null,
            loadMoreRenderer: function(index, domElement){
                domElement.innerHTML = 'Loading...';
            },
            hasMore: function () {
                return false;
            },
        },
        parentElement = null,
        rootElement = null,
        scrollElement = null,
        scrollbar = null,
        scroller = null,
        visibleHeight = 0,
        renderedListItems = [],
        accumulatedRowHeights = [],
        layersPool = new LayersPool(),
        touchConnector = null,
        topOffset = 0,
        runAnimation = false,
        needsRender = true,
        measuredFPS = 60;

    for (var key in listConfig){
        if (listConfig.hasOwnProperty(key)){
            config[key] = listConfig[key];
        }
    }

    function attach(domElement, touchProvider){
        parentElement = domElement;
        visibleHeight = parentElement.clientHeight;
        initializeRootElement(domElement);
        initializeScroller(domElement, touchProvider);
        window.addEventListener('resize', refresh.bind(this));
        runAnimationLoop();
        refresh();
        return this;
    }

    function detach() {
        runAnimation = false;
        if (touchConnector){
            touchConnector.disconnect();
        }
        parentElement.removeChild(rootElement);
        window.removeEventListener('resize', refresh.bind(this));
    }

    function runAnimationLoop(){
        var lastStepTime = new Date().getTime(),
            frames = 0;
        runAnimation = true;
        var animationStep = function(){
            var currentTime = new Date().getTime();
            frames++;
            if (currentTime - lastStepTime > 200) {
                measuredFPS = Math.min(60, 1000 * frames / (currentTime - lastStepTime));
                lastStepTime = currentTime;
                frames = 0;
            }
            if (needsRender) {
                render();
            }
            if (runAnimation) {
                requestAnimationFrame(animationStep);
            }
        };
        requestAnimationFrame(animationStep);
    }

    function calculateHeights() {
        var count = config.itemsCount();
        accumulatedRowHeights = [0];
        for (var i = 1; i <= count || 0; ++i) {
            var currentRowHeight = config.itemHeightGetter ? config.itemHeightGetter(i - 1) : DEFAULT_ITEM_HEIGHT;
            accumulatedRowHeights[i] = accumulatedRowHeights[i - 1] + currentRowHeight;
        }
    }

    /*
     This method creates the list various elements:
     1. rootElement - the root element of the list which is the only one that has a relative position.
     all other elements are child of the root and has absolute position so the layout cycle will be minimal
     2. scrollElement - this one is the parent of all list items and is translated according to the top position given
     by the scroller
     3. scrollbar - the vertical scrollbar. The scrollbar is rendered because I don't use the native scroller here.
     */
    function initializeRootElement(parentElement) {
        scrollElement = document.createElement('div');
        StyleHelpers.applyElementStyle(scrollElement, {
            position: 'absolute',
            top: 0,
            bottom: 0
        });

        rootElement = document.createElement('div');
        StyleHelpers.applyElementStyle(rootElement, {
            position: 'relative',
            height: parentElement.clientHeight + 'px',
            width: parentElement.clientWidth + 'px',
            overflow: 'hidden'
        });
        rootElement.appendChild(scrollElement);

        scrollbar = document.createElement('div');
        StyleHelpers.applyElementStyle(scrollbar, {
            position: 'absolute',
            top: '0px',
            right: '0px',
            marginRight: '3px',
            opacity: 0.3,
            width: '2px',
            backgroundColor: '#333',
            borderRadius: '50px'
        });
        rootElement.appendChild(scrollbar);
        parentElement.appendChild(
            rootElement);
    }

    /*
     Initialize the scroller
     The scroller is fed with touch input and is responsible for caculating momentum and eventually invoke a
     callback with the scrolling position when changed.
     I have used ZyngaScroller for that: https://github.com/zynga/scroller
     */
    function initializeScroller(parentElement, touchProvider) {

        scroller = new TouchScroller(
            parentElement,

            function (left, top) {
                topOffset = top || 0;
                needsRender = true;
            },

            touchProvider
        );
    }

    function updateScrollerDimentions(parentElement){

        scroller.setDimensions(
            parentElement.clientWidth,
            parentElement.clientHeight,
            parentElement.clientWidth,
            getListHeight()
        );
    }

    function refresh(){
        StyleHelpers.applyElementStyle(rootElement, {
            height: parentElement.clientHeight + 'px',
            width: parentElement.clientWidth + 'px'
        });

        renderedListItems.forEach(function(layer){
            layersPool.addLayer(layer, true);
        });
        renderedListItems = [];
        calculateHeights();
        updateScrollerDimentions(parentElement);
        needsRender = true;
    }

    function isBusy(){
        return measuredFPS < MIN_FPS;
    }

    var itemsNeedRerender = {};

    /*
     This method fix the list according to the top positoin:
     1. render the list items, recycle from the pool if needed and bring not needed items back to the pool.
     2. update the scrollbar
     3. translate the view according to the scrolling position
     */
    function render() {

        var topVisibleIndex = getFirstVisibleItemAtHeight(topOffset),
            bottomVisibleIndex = getFirstVisibleItemAtHeight(topOffset + visibleHeight),
            count = config.itemsCount(),
            hasMore = config.hasMore();

        if (!hasMore){
            bottomVisibleIndex = Math.min(bottomVisibleIndex, count - 1);
        }
        //remove non-visible layers from top and push them to layerPool
        while (renderedListItems.length > 0 && renderedListItems[0].getItemIndex() < topVisibleIndex) {
            layersPool.addLayer(renderedListItems.shift());
        }

        //remove non-visible layers from bottom and push them to layerPool
        while (renderedListItems.length > 0 && renderedListItems[renderedListItems.length - 1].getItemIndex() > bottomVisibleIndex) {
            layersPool.addLayer(renderedListItems.pop());
        }

        var renderedStart = renderedListItems.length > 0 ? renderedListItems[0].getItemIndex() : (bottomVisibleIndex + 1),
            topItems = [];

        var systemBusyRenderer = function(index, domElement){
                domElement.innerHTML = "Loading...";
            },
            itemRendered = false,
            renderListItem = function(listItem){
                var renderBusy =  isBusy();
                var renderer = !renderBusy ? config.itemRenderer : systemBusyRenderer;
                renderer(listItem.getItemIndex(), listItem.getDomElement());
                if (renderBusy){
                    itemsNeedRerender[listItem.getItemIndex()] = listItem;
                }
            };

        //fill the gaps on top
        for (var i = topVisibleIndex; i < renderedStart; ++i) {
            renderListItem(pushLayerAtIndex(i, topItems));
            itemRendered = true;
        }
        renderedListItems = topItems.concat(renderedListItems);

        //fill the gaps on bottom
        if (renderedListItems.length) {
            for (i = renderedListItems[renderedListItems.length - 1].getItemIndex() + 1; i <= Math.min(count - 1, bottomVisibleIndex); ++i) {
                renderListItem(pushLayerAtIndex(i, renderedListItems));
                itemRendered = true;
            }
        }

        var indicesForRerender = Object.keys(itemsNeedRerender);
        if (!itemRendered && !isBusy()){
            if (indicesForRerender.length > 0){
                var indexToRender = indicesForRerender.shift();
                config.itemRenderer(itemsNeedRerender[indexToRender].getItemIndex(), itemsNeedRerender[indexToRender].getDomElement());
                delete itemsNeedRerender[indexToRender];
            }
        }

        if (bottomVisibleIndex > count - 1){
            renderLoadMore();
        }

        updateScrollbar();
        StyleHelpers.applyTransformStyle(scrollElement, 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0' + ',' + (-topOffset) + ', 0, 1)');
        needsRender = (indicesForRerender.length > 0);
    }

    /*
     Update the scrollbar size and position.
     */
    function updateScrollbar() {
        var listHeight = getListHeight(),
            attachedElement = rootElement.parentElement,
            scrollbarHeight = Math.max(10, Math.floor(attachedElement.clientHeight / listHeight * attachedElement.clientHeight)),
            scrollbarPos = Math.floor(topOffset / (listHeight - attachedElement.clientHeight) * (attachedElement.clientHeight - scrollbarHeight)),
            heightInPx = scrollbarHeight + 'px';

        StyleHelpers.applyElementStyle(scrollbar, {
            height: heightInPx
        });
        StyleHelpers.applyTransformStyle(scrollbar, 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0' + ',' + ( scrollbarPos) + ', 0, 1)');
    }

    function getListHeight(){
        return accumulatedRowHeights[accumulatedRowHeights.length - 1] + (!config.hasMore() ? 0 : DEFAULT_ITEM_HEIGHT);
    }

    /*
     Borrow a layer from the LayersPool and attach it to a certain item at index.
     */
    function pushLayerAtIndex(index, listItems, identifier, height) {
        var layerIdentifier = identifier || (config.itemTypeGetter ? config.itemTypeGetter(index) : '');
        var layer = layersPool.borrowLayerWithIdentifier(layerIdentifier);
        if (layer == null) { //jshint ignore:line
            layer = new Layer(scrollElement);
        }
        //index, topOffset, renderer, width, height, itemIdentifier
        var itemHeight = height || config.itemHeightGetter && config.itemHeightGetter(index);
        layer.attach(index, accumulatedRowHeights[index], rootElement.clientWidth, itemHeight, layerIdentifier);
        listItems.push(layer);
        return layer;
    }

    function renderLoadMore(){
        var count = config.itemsCount();
        if (renderedListItems[renderedListItems.length - 1].getIdentifier() != '$LoadMore') {
            var loadMoreLayer = pushLayerAtIndex(count, renderedListItems, '$LoadMore', -1);
            config.loadMoreRenderer(count, loadMoreLayer.getDomElement());
            config.pageFetcher(count, function(){
                refresh();
            });
        }
    }

    function getFirstVisibleItemAtHeight(top) {
        var i = 0;
        var count = config.itemsCount();

        while (i < count && accumulatedRowHeights[i + 1] < top) {
            i++;
        }
        return i;
    }

    function scrollToItem(index, animate) {
        scroller.scrollTo(0, accumulatedRowHeights[index], animate);
    }

    return {
        attach: attach,
        detach: detach,
        scrollToItem: scrollToItem,
        refresh: refresh
    };

};

module.exports = InfiniteList;
