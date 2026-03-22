"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
exports.id = "vendor-chunks/use-effect-event@2.0.3_react@19.0.0";
exports.ids = ["vendor-chunks/use-effect-event@2.0.3_react@19.0.0"];
exports.modules = {

/***/ "(ssr)/../../node_modules/.pnpm/use-effect-event@2.0.3_react@19.0.0/node_modules/use-effect-event/dist/index.js":
/*!****************************************************************************************************************!*\
  !*** ../../node_modules/.pnpm/use-effect-event@2.0.3_react@19.0.0/node_modules/use-effect-event/dist/index.js ***!
  \****************************************************************************************************************/
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   useEffectEvent: () => (/* binding */ useEffectEvent)\n/* harmony export */ });\n/* harmony import */ var react__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! react */ \"(ssr)/../../node_modules/.pnpm/next@15.2.8_@babel+core@7.29.0_react-dom@19.0.0_react@19.0.0__react@19.0.0/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react.js\");\n\nconst context = react__WEBPACK_IMPORTED_MODULE_0__.createContext(!0);\nfunction forbiddenInRender() {\n  throw new Error(\"A function wrapped in useEffectEvent can't be called during rendering.\");\n}\nconst isInvalidExecutionContextForEventFunction = \"use\" in react__WEBPACK_IMPORTED_MODULE_0__ ? () => {\n  try {\n    return react__WEBPACK_IMPORTED_MODULE_0__.use(context);\n  } catch {\n    return !1;\n  }\n} : () => !1;\nfunction useEffectEvent(fn) {\n  const ref = react__WEBPACK_IMPORTED_MODULE_0__.useRef(forbiddenInRender);\n  return react__WEBPACK_IMPORTED_MODULE_0__.useInsertionEffect(() => {\n    ref.current = fn;\n  }, [fn]), (...args) => {\n    isInvalidExecutionContextForEventFunction() && forbiddenInRender();\n    const latestFn = ref.current;\n    return latestFn(...args);\n  };\n}\n\n//# sourceMappingURL=index.js.map\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKHNzcikvLi4vLi4vbm9kZV9tb2R1bGVzLy5wbnBtL3VzZS1lZmZlY3QtZXZlbnRAMi4wLjNfcmVhY3RAMTkuMC4wL25vZGVfbW9kdWxlcy91c2UtZWZmZWN0LWV2ZW50L2Rpc3QvaW5kZXguanMiLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBMEI7QUFDMUIsZ0JBQWdCLGdEQUFtQjtBQUNuQztBQUNBO0FBQ0E7QUFDQSxrREFBa0QsMkNBQWM7QUFDaEU7QUFDQSxXQUFXLHNDQUFTO0FBQ3BCLElBQUk7QUFDSjtBQUNBO0FBQ0EsRUFBRTtBQUNGO0FBQ0EsY0FBYyx5Q0FBWTtBQUMxQixTQUFTLHFEQUF3QjtBQUNqQztBQUNBLEdBQUc7QUFDSDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBR0U7QUFDRiIsInNvdXJjZXMiOlsiL1VzZXJzL3l1cnkvUHJvamVjdHMvYWktc2l0ZS1lZGl0b3Ivbm9kZV9tb2R1bGVzLy5wbnBtL3VzZS1lZmZlY3QtZXZlbnRAMi4wLjNfcmVhY3RAMTkuMC4wL25vZGVfbW9kdWxlcy91c2UtZWZmZWN0LWV2ZW50L2Rpc3QvaW5kZXguanMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0IGZyb20gXCJyZWFjdFwiO1xuY29uc3QgY29udGV4dCA9IFJlYWN0LmNyZWF0ZUNvbnRleHQoITApO1xuZnVuY3Rpb24gZm9yYmlkZGVuSW5SZW5kZXIoKSB7XG4gIHRocm93IG5ldyBFcnJvcihcIkEgZnVuY3Rpb24gd3JhcHBlZCBpbiB1c2VFZmZlY3RFdmVudCBjYW4ndCBiZSBjYWxsZWQgZHVyaW5nIHJlbmRlcmluZy5cIik7XG59XG5jb25zdCBpc0ludmFsaWRFeGVjdXRpb25Db250ZXh0Rm9yRXZlbnRGdW5jdGlvbiA9IFwidXNlXCIgaW4gUmVhY3QgPyAoKSA9PiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIFJlYWN0LnVzZShjb250ZXh0KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuICExO1xuICB9XG59IDogKCkgPT4gITE7XG5mdW5jdGlvbiB1c2VFZmZlY3RFdmVudChmbikge1xuICBjb25zdCByZWYgPSBSZWFjdC51c2VSZWYoZm9yYmlkZGVuSW5SZW5kZXIpO1xuICByZXR1cm4gUmVhY3QudXNlSW5zZXJ0aW9uRWZmZWN0KCgpID0+IHtcbiAgICByZWYuY3VycmVudCA9IGZuO1xuICB9LCBbZm5dKSwgKC4uLmFyZ3MpID0+IHtcbiAgICBpc0ludmFsaWRFeGVjdXRpb25Db250ZXh0Rm9yRXZlbnRGdW5jdGlvbigpICYmIGZvcmJpZGRlbkluUmVuZGVyKCk7XG4gICAgY29uc3QgbGF0ZXN0Rm4gPSByZWYuY3VycmVudDtcbiAgICByZXR1cm4gbGF0ZXN0Rm4oLi4uYXJncyk7XG4gIH07XG59XG5leHBvcnQge1xuICB1c2VFZmZlY3RFdmVudFxufTtcbi8vIyBzb3VyY2VNYXBwaW5nVVJMPWluZGV4LmpzLm1hcFxuIl0sIm5hbWVzIjpbXSwiaWdub3JlTGlzdCI6WzBdLCJzb3VyY2VSb290IjoiIn0=\n//# sourceURL=webpack-internal:///(ssr)/../../node_modules/.pnpm/use-effect-event@2.0.3_react@19.0.0/node_modules/use-effect-event/dist/index.js\n");

/***/ })

};
;