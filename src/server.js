"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
exports.__esModule = true;
var express_1 = __importDefault(require("express"));
var node_fetch_1 = __importDefault(require("node-fetch"));
var pdiiif_1 = require("pdiiif");
var range_1 = __importDefault(require("lodash/range"));
var accept_language_parser_1 = __importDefault(require("accept-language-parser"));
var app = express_1["default"]();
var progressClients = {};
app.get('/api/progress/:token', function (req, res) {
    var token = req.params.token;
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
    });
    res.flushHeaders();
    progressClients[token] = res;
    req.on('close', function () {
        delete progressClients[token];
    });
});
app.get('/api/generate-pdf', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, manifestUrl, canvasNos, locale, progressToken, manifestResp, manifestJson, languagePreference, canvasIds, canvasIdxs_1, onProgress;
    var _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0:
                _a = req.query, manifestUrl = _a.manifestUrl, canvasNos = _a.canvasNos, locale = _a.locale, progressToken = _a.progressToken;
                if (!manifestUrl || typeof manifestUrl !== 'string') {
                    res.status(400).json({
                        reason: 'manifestUrl parameter is mandatory and must be single-valued'
                    }).send();
                    return [2 /*return*/];
                }
                return [4 /*yield*/, node_fetch_1["default"](manifestUrl)];
            case 1:
                manifestResp = _e.sent();
                if (manifestResp.status != 200) {
                    res.status(500).json({
                        reason: "Could not fetch manifest from " + manifestUrl + ", got HTTP status " + manifestResp.status
                    }).send();
                    return [2 /*return*/];
                }
                return [4 /*yield*/, manifestResp.json()];
            case 2:
                manifestJson = _e.sent();
                if (!manifestJson) {
                    res.status(500).json({
                        reason: "Response from " + manifestUrl + " did not contain valid IIIF Manifest."
                    }).send();
                    return [2 /*return*/];
                }
                res.writeHead(200, {
                    'Content-Type': 'application/pdf',
                    'Transfer-Encoding': 'chunked'
                });
                languagePreference = [];
                if (locale && typeof locale === 'string') {
                    // Explicit locale override from user
                    languagePreference = [locale];
                }
                else if (req.header('accept-language')) {
                    // Accept-Language header
                    languagePreference = accept_language_parser_1["default"].parse(req.header('accept-language')[0])
                        .map(function (l) { return l.region ? l.code + "-" + l.region : l.code; });
                }
                if (canvasNos && typeof canvasNos === 'string') {
                    canvasIdxs_1 = new Set(canvasNos.split(',').reduce(function (idxs, grp) {
                        if (grp.indexOf('-') > 0) {
                            var parts = grp.split('-');
                            idxs.concat(range_1["default"](Number.parseInt(parts[0]), Number.parseInt(parts[1])));
                        }
                        else {
                            idxs.push(Number.parseInt(grp));
                        }
                        return idxs;
                    }, []));
                    canvasIds = ((_b = manifestJson.items) !== null && _b !== void 0 ? _b : (_d = (_c = manifestJson.sequences) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.canvases)
                        .map(function (c) { var _a; return ((_a = c.id) !== null && _a !== void 0 ? _a : c['@id']); })
                        .filter(function (_, idx) { return canvasIdxs_1.has(idx); });
                }
                if (progressToken && typeof progressToken === 'string') {
                    onProgress = function (progressStatus) {
                        var clientResp = progressClients[progressToken];
                        if (clientResp) {
                            clientResp.write("data: " + JSON.stringify(progressStatus) + "\n\n");
                        }
                    };
                }
                return [4 /*yield*/, pdiiif_1.convertManifest(manifestJson, res, {
                        languagePreference: languagePreference,
                        filterCanvases: canvasIds,
                        onProgress: onProgress
                    })];
            case 3:
                _e.sent();
                if (progressToken && typeof progressToken === 'string') {
                    progressClients[progressToken].end(undefined, function () { return delete progressClients[progressToken]; });
                }
                res.end();
                return [2 /*return*/];
        }
    });
}); });
app.listen(31337, function () {
    console.log('server started at http://localhost:31337');
});
//# sourceMappingURL=server.js.map