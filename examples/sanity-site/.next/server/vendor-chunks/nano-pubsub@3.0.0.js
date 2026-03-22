"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
exports.id = "vendor-chunks/nano-pubsub@3.0.0";
exports.ids = ["vendor-chunks/nano-pubsub@3.0.0"];
exports.modules = {

/***/ "(ssr)/../../node_modules/.pnpm/nano-pubsub@3.0.0/node_modules/nano-pubsub/dist/index.js":
/*!*****************************************************************************************!*\
  !*** ../../node_modules/.pnpm/nano-pubsub@3.0.0/node_modules/nano-pubsub/dist/index.js ***!
  \*****************************************************************************************/
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   \"default\": () => (/* binding */ createPubSub)\n/* harmony export */ });\nfunction createPubSub() {\n  const subscribers = /* @__PURE__ */ Object.create(null);\n  let nextId = 0;\n  function subscribe(subscriber) {\n    const id = nextId++;\n    return subscribers[id] = subscriber, function() {\n      delete subscribers[id];\n    };\n  }\n  function publish(event) {\n    for (const id in subscribers)\n      subscribers[id](event);\n  }\n  return {\n    publish,\n    subscribe\n  };\n}\n\n//# sourceMappingURL=index.js.map\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKHNzcikvLi4vLi4vbm9kZV9tb2R1bGVzLy5wbnBtL25hbm8tcHVic3ViQDMuMC4wL25vZGVfbW9kdWxlcy9uYW5vLXB1YnN1Yi9kaXN0L2luZGV4LmpzIiwibWFwcGluZ3MiOiI7Ozs7QUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFHRTtBQUNGIiwic291cmNlcyI6WyIvVXNlcnMveXVyeS9Qcm9qZWN0cy9haS1zaXRlLWVkaXRvci9ub2RlX21vZHVsZXMvLnBucG0vbmFuby1wdWJzdWJAMy4wLjAvbm9kZV9tb2R1bGVzL25hbm8tcHVic3ViL2Rpc3QvaW5kZXguanMiXSwic291cmNlc0NvbnRlbnQiOlsiZnVuY3Rpb24gY3JlYXRlUHViU3ViKCkge1xuICBjb25zdCBzdWJzY3JpYmVycyA9IC8qIEBfX1BVUkVfXyAqLyBPYmplY3QuY3JlYXRlKG51bGwpO1xuICBsZXQgbmV4dElkID0gMDtcbiAgZnVuY3Rpb24gc3Vic2NyaWJlKHN1YnNjcmliZXIpIHtcbiAgICBjb25zdCBpZCA9IG5leHRJZCsrO1xuICAgIHJldHVybiBzdWJzY3JpYmVyc1tpZF0gPSBzdWJzY3JpYmVyLCBmdW5jdGlvbigpIHtcbiAgICAgIGRlbGV0ZSBzdWJzY3JpYmVyc1tpZF07XG4gICAgfTtcbiAgfVxuICBmdW5jdGlvbiBwdWJsaXNoKGV2ZW50KSB7XG4gICAgZm9yIChjb25zdCBpZCBpbiBzdWJzY3JpYmVycylcbiAgICAgIHN1YnNjcmliZXJzW2lkXShldmVudCk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBwdWJsaXNoLFxuICAgIHN1YnNjcmliZVxuICB9O1xufVxuZXhwb3J0IHtcbiAgY3JlYXRlUHViU3ViIGFzIGRlZmF1bHRcbn07XG4vLyMgc291cmNlTWFwcGluZ1VSTD1pbmRleC5qcy5tYXBcbiJdLCJuYW1lcyI6W10sImlnbm9yZUxpc3QiOlswXSwic291cmNlUm9vdCI6IiJ9\n//# sourceURL=webpack-internal:///(ssr)/../../node_modules/.pnpm/nano-pubsub@3.0.0/node_modules/nano-pubsub/dist/index.js\n");

/***/ })

};
;