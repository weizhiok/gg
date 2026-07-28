(function () {
    'use strict';

    var PAYLOAD = 'payload.txt';
    var URL_FILE = 'url.txt';
    var PAYLOAD_SIZE = 128684;
    var FALLBACK = 16384;
    var OVERHEAD = 4096;
    var MAX_URLS = 100;
    var MAX_EXT = 262144;
    var MAX_ROUTE = 5120;
    var ROUTE_TIMEOUT = 5000;
    var EXTERNAL_TIMEOUT = 10000;
    var HISTORY = 'ggHistoryV2';
    var AMOUNTS = {
        '0.01': ['£0.01', 42895],
        '0.02': ['£0.02', 85790],
        '0.03': ['£0.03', 128684]
    };

    function byId(id) {
        return document.getElementById(id);
    }

    var amount = byId('amountSelect');
    var start = byId('consumeButton');
    var check = byId('checkButton');
    var clear = byId('clearButton');
    var input = byId('urlInput');
    var urlSummary = byId('urlSummary');
    var routeSummary = byId('routeSummary');
    var routeResults = byId('routeResults');
    var budgetTitle = byId('budgetTitle');
    var budgetSummary = byId('budgetSummary');
    var budgetDetail = byId('budgetDetail');
    var status = byId('status');
    var historyList = byId('historyList');

    var pageBytes = 0;
    var cutoff = window.performance && performance.now ? performance.now() : 0;
    var busy = false;
    var checking = false;
    var loading = true;
    var measurePromise = null;

    function randomUnit() {
        if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
            var values = new Uint32Array(1);
            window.crypto.getRandomValues(values);
            return values[0] / 4294967296;
        }
        return Math.random();
    }

    function randomInt(min, max) {
        return Math.floor(randomUnit() * (max - min + 1)) + min;
    }

    function shuffle(items) {
        var result = items.slice();
        var i;
        var j;
        var temp;
        for (i = result.length - 1; i > 0; i -= 1) {
            j = randomInt(0, i);
            temp = result[i];
            result[i] = result[j];
            result[j] = temp;
        }
        return result;
    }

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes)) {
            return '—';
        }
        if (bytes < 1024) {
            return Math.round(bytes) + ' B';
        }
        if (bytes < 1048576) {
            return (bytes / 1024).toFixed(2) + ' KB';
        }
        return (bytes / 1048576).toFixed(2) + ' MB';
    }

    function utf8Length(text) {
        try {
            return unescape(encodeURIComponent(text)).length;
        } catch (error) {
            return text.length;
        }
    }

    function readStore(key, fallback) {
        try {
            var value = localStorage.getItem(key);
            return value === null ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    function writeStore(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (error) {
            // Safari 隐私模式或存储被禁用时，不影响主要功能。
        }
    }

    function sameOrigin(url) {
        try {
            return new URL(url, window.location.href).origin === window.location.origin;
        } catch (error) {
            return false;
        }
    }

    function responseMetricBytes(entry) {
        if (!entry) {
            return 0;
        }
        return Number(entry.transferSize) || Number(entry.encodedBodySize) || 0;
    }

    function preview() {
        var selected = AMOUNTS[amount.value] || AMOUNTS['0.01'];
        var label = selected[0];
        var base = selected[1];
        var min = Math.round(base * 0.8);
        var max = Math.round(base * 1.2);
        var reserve = (pageBytes || FALLBACK) + OVERHEAD;

        budgetTitle.textContent = '本次目标：' + label + '（实际会随机 ±20%）';
        budgetSummary.textContent = '总目标约 ' + formatBytes(min) + '–' + formatBytes(max) +
            '；页面初始流量已计入：' + formatBytes(pageBytes || FALLBACK);
        budgetDetail.textContent = 'URL 与自有填充可使用约 ' +
            formatBytes(Math.max(0, min - reserve)) + '–' +
            formatBytes(Math.max(0, max - reserve)) +
            '（另预留 ' + formatBytes(OVERHEAD) + ' 协议开销）';
    }

    function measure() {
        var total = 0;
        var navigation;
        var resources;
        var i;
        var markupBytes;

        if (pageBytes) {
            return;
        }

        if (window.performance && typeof performance.getEntriesByType === 'function') {
            navigation = performance.getEntriesByType('navigation')[0];
            total += responseMetricBytes(navigation);
            resources = performance.getEntriesByType('resource');
            for (i = 0; i < resources.length; i += 1) {
                if (resources[i].startTime <= cutoff && sameOrigin(resources[i].name)) {
                    total += responseMetricBytes(resources[i]);
                }
            }
        }

        if (!total) {
            markupBytes = utf8Length(document.documentElement.outerHTML);
            total = Math.max(FALLBACK, Math.min(markupBytes, 32768));
        }

        pageBytes = Math.round(total);
        preview();
    }

    function waitMeasure() {
        if (pageBytes) {
            return Promise.resolve();
        }
        if (!measurePromise) {
            measurePromise = new Promise(function (resolve) {
                function finish() {
                    cutoff = window.performance && performance.now ? performance.now() : 0;
                    measure();
                    resolve();
                }
                if (document.readyState === 'complete') {
                    finish();
                } else {
                    window.addEventListener('load', finish, false);
                }
            });
        }
        return measurePromise;
    }

    function parseLine(line) {
        var text = line.trim();
        var match;
        var expected;
        var legacy = false;
        var parsed;

        if (!text) {
            return null;
        }

        match = /\s*\|\s*(\d+)\s*$/.exec(text);
        if (match) {
            expected = Number(match[1]);
            if (!Number.isInteger(expected) || expected < 1 || expected > MAX_EXT) {
                throw new Error('预计字节数必须在 1–262144 之间');
            }
            text = text.slice(0, match.index).trim();
            legacy = true;
        }

        parsed = new URL(text);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('只允许 HTTP/HTTPS URL');
        }
        if (window.location.protocol === 'https:' && parsed.protocol !== 'https:') {
            throw new Error('HTTPS 页面不能读取 HTTP 资源');
        }
        if (parsed.username || parsed.password) {
            throw new Error('不允许包含账号或密码的 URL');
        }
        parsed.hash = '';
        return { url: parsed.href, old: legacy };
    }

    function parseUrls() {
        var records = [];
        var invalid = [];
        var seen = {};
        var lines = input.value.split(/\r?\n/);
        var i;
        var record;

        for (i = 0; i < lines.length; i += 1) {
            if (!lines[i].trim()) {
                continue;
            }
            if (records.length >= MAX_URLS) {
                invalid.push([i + 1, '超过最多 ' + MAX_URLS + ' 条']);
                continue;
            }
            try {
                record = parseLine(lines[i]);
                if (record && !seen[record.url]) {
                    seen[record.url] = true;
                    records.push(record);
                }
            } catch (error) {
                invalid.push([i + 1, error.message || 'URL 无效']);
            }
        }
        return { records: records, invalid: invalid };
    }

    function updateSummary() {
        var parsed = parseUrls();
        var oldCount = 0;
        var i;

        if (!parsed.records.length) {
            urlSummary.textContent = '当前为空：点击开始时将全部使用页面自身填充文件。';
            return;
        }
        for (i = 0; i < parsed.records.length; i += 1) {
            if (parsed.records[i].old) {
                oldCount += 1;
            }
        }
        urlSummary.textContent = '已识别 ' + parsed.records.length + ' 个 URL' +
            (oldCount ? '，其中 ' + oldCount + ' 个含旧版预计字节写法' : '') +
            (parsed.invalid.length ? '；忽略 ' + parsed.invalid.length + ' 行' : '');
    }

    function fetchWithTimeout(url, options, milliseconds) {
        return new Promise(function (resolve, reject) {
            var settled = false;
            var controller = null;
            var timer;
            var requestOptions = options || {};
            var key;
            var copiedOptions = {};

            for (key in requestOptions) {
                if (Object.prototype.hasOwnProperty.call(requestOptions, key)) {
                    copiedOptions[key] = requestOptions[key];
                }
            }

            if (typeof window.AbortController === 'function') {
                controller = new window.AbortController();
                copiedOptions.signal = controller.signal;
            }

            timer = window.setTimeout(function () {
                var timeoutError;
                if (settled) {
                    return;
                }
                settled = true;
                if (controller) {
                    controller.abort();
                }
                timeoutError = new Error('请求超过 ' + (milliseconds / 1000) + ' 秒');
                timeoutError.name = 'TimeoutError';
                reject(timeoutError);
            }, milliseconds);

            window.fetch(url, copiedOptions).then(function (response) {
                if (settled) {
                    return;
                }
                settled = true;
                window.clearTimeout(timer);
                resolve(response);
            }, function (error) {
                if (settled) {
                    return;
                }
                settled = true;
                window.clearTimeout(timer);
                reject(error);
            });
        });
    }

    function readBytes(response, limit) {
        if (response.type === 'opaque') {
            return Promise.reject(new Error('CORS 不允许读取响应'));
        }

        if (!response.body || typeof response.body.getReader !== 'function') {
            return response.blob().then(function (blob) {
                return {
                    bytes: Math.min(blob.size, limit),
                    truncated: blob.size > limit
                };
            });
        }

        return new Promise(function (resolve, reject) {
            var reader = response.body.getReader();
            var bytes = 0;
            var truncated = false;

            function finish() {
                try {
                    reader.releaseLock();
                } catch (error) {
                    // 某些旧版 Safari 不允许在读取结束后再次释放锁。
                }
                resolve({ bytes: bytes, truncated: truncated });
            }

            function pump() {
                reader.read().then(function (part) {
                    var length;
                    if (part.done) {
                        finish();
                        return;
                    }
                    length = part.value && part.value.byteLength ? part.value.byteLength : 0;
                    if (bytes + length > limit) {
                        bytes = limit;
                        truncated = true;
                        if (typeof reader.cancel === 'function') {
                            reader.cancel();
                        }
                        finish();
                        return;
                    }
                    bytes += length;
                    pump();
                }, function (error) {
                    reject(error);
                });
            }

            pump();
        });
    }

    function loadUrls() {
        var configUrl = new URL(URL_FILE, window.location.href);
        configUrl.searchParams.set('_ts', String(new Date().getTime()));

        start.disabled = true;
        check.disabled = true;
        clear.disabled = true;
        routeSummary.textContent = '正在从 url.txt 加载默认线路…';

        return fetchWithTimeout(configUrl.href, {
            cache: 'no-store',
            credentials: 'same-origin'
        }, 10000).then(function (response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return response.text();
        }).then(function (text) {
            input.value = text.trim();
            routeSummary.textContent = input.value ?
                '已从 url.txt 加载默认线路；当前修改仅在本页面临时有效。' :
                'url.txt 当前为空；运行时将使用页面自身填充文件。';
        }, function (error) {
            input.value = '';
            routeSummary.textContent = '默认线路加载失败（' +
                (error.message || '未知错误') +
                '），可手动输入；留空将使用页面自身填充文件。';
        }).then(function () {
            cutoff = window.performance && performance.now ? performance.now() : 0;
            updateSummary();
            return waitMeasure();
        }).then(function () {
            loading = false;
            start.disabled = false;
            check.disabled = false;
            clear.disabled = false;
        }, function () {
            loading = false;
            start.disabled = false;
            check.disabled = false;
            clear.disabled = false;
            budgetSummary.textContent = '页面初始流量读取失败，已使用兼容估算值。';
            preview();
        });
    }

    function readExternal(record, cap) {
        var started = new Date().getTime();
        return fetchWithTimeout(record.url, {
            mode: 'cors',
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'follow'
        }, EXTERNAL_TIMEOUT).then(function (response) {
            if (response.type === 'opaque') {
                throw new Error('CORS 不允许读取响应');
            }
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return readBytes(response, Math.min(cap, MAX_EXT)).then(function (body) {
                return {
                    ok: true,
                    bytes: body.bytes,
                    duration: new Date().getTime() - started,
                    finalUrl: response.url,
                    type: response.headers.get('content-type') || ''
                };
            });
        });
    }

    function filler(needed, id) {
        var left = Math.max(0, Math.floor(needed));
        var offset = 0;
        var total = 0;
        var count = 0;

        function next() {
            var rangeStart;
            var size;
            var rangeEnd;
            var resourceUrl;

            if (left <= 0) {
                return Promise.resolve({ bytes: total, count: count });
            }
            if (count >= 12) {
                return Promise.reject(new Error('自有填充文件未能达到目标字节数'));
            }

            rangeStart = offset % PAYLOAD_SIZE;
            size = Math.min(left, PAYLOAD_SIZE - rangeStart);
            rangeEnd = rangeStart + size - 1;
            resourceUrl = new URL(PAYLOAD, window.location.href);
            resourceUrl.searchParams.set('part', String(count));
            resourceUrl.searchParams.set('_gg', id + '-' + Math.floor(randomUnit() * 1000000000));

            return window.fetch(resourceUrl.href, {
                cache: 'no-store',
                headers: { Range: 'bytes=' + rangeStart + '-' + rangeEnd }
            }).then(function (response) {
                if (!response.ok && response.status !== 206) {
                    throw new Error('自有填充文件请求失败（HTTP ' + response.status + '）');
                }
                return readBytes(response, size);
            }).then(function (body) {
                if (!body.bytes) {
                    throw new Error('自有填充文件返回为空');
                }
                total += body.bytes;
                left -= body.bytes;
                offset = (rangeStart + body.bytes) % PAYLOAD_SIZE;
                count += 1;
                return next();
            });
        }

        return next();
    }

    function renderHistory() {
        var items = [];
        var visible;
        var i;
        var row;
        var item;

        historyList.textContent = '';
        try {
            items = JSON.parse(readStore(HISTORY, '[]'));
            if (!Array.isArray(items)) {
                items = [];
            }
        } catch (error) {
            items = [];
        }

        if (!items.length) {
            row = document.createElement('div');
            row.className = 'history-item';
            row.textContent = '暂无记录';
            historyList.appendChild(row);
            return;
        }

        visible = items.slice(-5).reverse();
        for (i = 0; i < visible.length; i += 1) {
            item = visible[i];
            row = document.createElement('div');
            row.className = 'history-item';
            row.textContent = '✓ ' + item.date + ' · ' + item.amount +
                ' · 总计约 ' + formatBytes(item.totalBytes) +
                (item.urlCount ? '，URL ' + item.urlCount + ' 个' : '，纯自有填充');
            historyList.appendChild(row);
        }
    }

    function saveHistory(item) {
        var items = [];
        try {
            items = JSON.parse(readStore(HISTORY, '[]'));
            if (!Array.isArray(items)) {
                items = [];
            }
        } catch (error) {
            items = [];
        }
        items.push(item);
        writeStore(HISTORY, JSON.stringify(items.slice(-20)));
        renderHistory();
    }

    function renderRoutes(items) {
        var i;
        var item;
        var row;
        var state;
        var detail;
        var corsText;

        routeResults.textContent = '';
        for (i = 0; i < items.length; i += 1) {
            item = items[i];
            row = document.createElement('div');
            row.className = 'route-row';
            state = document.createElement('span');
            state.className = 'route-state ' + (item.keep ? 'route-ok' : 'route-fail');
            state.textContent = item.keep ? '保留' : '移除';
            detail = document.createElement('span');
            detail.className = 'route-detail';
            corsText = item.cors === true ? '是' : (item.cors === false ? '否' : '未知');
            detail.textContent = item.url + ' · HTTP ' +
                (item.status === null || typeof item.status === 'undefined' ? '—' : item.status) +
                ' · CORS：' + corsText +
                ' · 正文：' + (item.size || '—') +
                (item.reason ? ' · ' + item.reason : '');
            row.appendChild(state);
            row.appendChild(detail);
            routeResults.appendChild(row);
        }
    }

    function probe(record) {
        var response = null;
        return fetchWithTimeout(record.url, {
            mode: 'cors',
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'follow'
        }, ROUTE_TIMEOUT).then(function (result) {
            var cors;
            var base;
            var length;
            response = result;
            cors = result.type === 'cors' || result.type === 'basic' || sameOrigin(result.url);
            base = {
                url: record.url,
                status: result.status,
                cors: cors
            };

            if (!cors || result.type === 'opaque') {
                base.reason = 'CORS 未通过';
                return base;
            }
            if (!result.ok) {
                base.reason = 'HTTP 状态不是 2xx';
                return base;
            }
            if (new URL(result.url).protocol !== 'https:') {
                base.reason = '最终地址不是 HTTPS';
                return base;
            }

            length = Number(result.headers.get('content-length'));
            if (Number.isFinite(length) && length > MAX_ROUTE) {
                base.size = formatBytes(length) + '（超过 5120 B）';
                base.reason = '正文过大';
                return base;
            }

            return readBytes(result, MAX_ROUTE).then(function (body) {
                if (body.truncated) {
                    base.size = '>' + MAX_ROUTE + ' B';
                    base.reason = '正文过大';
                    return base;
                }
                if (!body.bytes) {
                    base.size = '0 B';
                    base.reason = '正文为空';
                    return base;
                }
                base.keep = true;
                base.size = formatBytes(body.bytes);
                return base;
            });
        }, function (error) {
            return {
                url: record.url,
                status: response ? response.status : null,
                cors: response ? false : null,
                reason: error.name === 'TimeoutError' ?
                    '请求超过 ' + (ROUTE_TIMEOUT / 1000) + ' 秒' :
                    (error.message || '请求失败')
            };
        });
    }

    function checkRoutes() {
        var parsed;
        var results;
        var index = 0;

        if (busy || checking || loading) {
            return;
        }

        parsed = parseUrls();
        if (!parsed.records.length) {
            input.value = '';
            updateSummary();
            routeSummary.textContent = '当前没有可检测的有效 URL；运行时将使用页面自身填充。';
            return;
        }

        checking = true;
        start.disabled = true;
        check.disabled = true;
        clear.disabled = true;
        results = parsed.invalid.map(function (item) {
            return { url: '第 ' + item[0] + ' 行', reason: item[1] };
        });
        renderRoutes(results);

        function finish() {
            var kept = [];
            var i;
            for (i = 0; i < results.length; i += 1) {
                if (results[i].keep) {
                    kept.push(results[i].url);
                }
            }
            input.value = kept.join('\n');
            updateSummary();
            routeSummary.textContent = '检测完成：共 ' + results.length + ' 条，保留 ' +
                kept.length + ' 条，移除 ' + (results.length - kept.length) +
                ' 条；结果仅在当前页面有效。';
            checking = false;
            start.disabled = false;
            check.disabled = false;
            clear.disabled = false;
        }

        function next() {
            if (index >= parsed.records.length) {
                finish();
                return Promise.resolve();
            }
            routeSummary.textContent = '正在检测 ' + (index + 1) + '/' + parsed.records.length +
                '（单条最多 ' + (ROUTE_TIMEOUT / 1000) + ' 秒）：' + parsed.records[index].url;
            return probe(parsed.records[index]).then(function (result) {
                results.push(result);
                renderRoutes(results);
                index += 1;
                return next();
            });
        }

        next().then(null, function (error) {
            routeSummary.textContent = '检测中断：' + (error.message || '未知错误');
            checking = false;
            start.disabled = false;
            check.disabled = false;
            clear.disabled = false;
        });
    }

    function show(kind, title, detail) {
        var titleNode;
        var detailNode;
        status.className = kind;
        status.textContent = '';
        titleNode = document.createElement('div');
        titleNode.textContent = title;
        status.appendChild(titleNode);
        if (detail) {
            detailNode = document.createElement('div');
            detailNode.className = 'stats';
            detailNode.textContent = detail;
            status.appendChild(detailNode);
        }
    }

    function consume() {
        var started;
        var parsed;
        var selected;
        var label;
        var base;
        var target;
        var budget;
        var id;
        var chosen;
        var externalBytes = 0;
        var failed = 0;
        var index = 0;

        if (busy || checking || loading) {
            return;
        }

        busy = true;
        start.disabled = true;
        check.disabled = true;
        clear.disabled = true;
        started = new Date().getTime();

        waitMeasure().then(function () {
            parsed = parseUrls();
            selected = AMOUNTS[amount.value] || AMOUNTS['0.01'];
            label = selected[0];
            base = selected[1];
            target = Math.round(base * (0.8 + randomUnit() * 0.4));
            budget = Math.max(1024, target - ((pageBytes || FALLBACK) + OVERHEAD));
            id = new Date().getTime().toString(36) + '-' +
                Math.floor(randomUnit() * 1000000000).toString(36);
            chosen = shuffle(parsed.records).slice(0,
                parsed.records.length >= 3 ? randomInt(3, Math.min(5, parsed.records.length)) : parsed.records.length);

            show('loading', '📡 正在执行本次测试…',
                '目标总量 ' + formatBytes(target) +
                '；已扣除页面初始流量 ' + formatBytes(pageBytes || FALLBACK));

            function nextExternal() {
                var cap;
                if (index >= chosen.length) {
                    return Promise.resolve();
                }
                cap = Math.max(1, Math.floor((budget - externalBytes) / (chosen.length - index)));
                return readExternal(chosen[index], cap).then(function (result) {
                    externalBytes += result.bytes;
                }, function () {
                    failed += 1;
                }).then(function () {
                    show('loading', '🌐 正在访问自定义 URL（' + (index + 1) + '/' + chosen.length + '）…',
                        '已读取 ' + formatBytes(externalBytes));
                    index += 1;
                    return nextExternal();
                });
            }

            return nextExternal();
        }).then(function () {
            var remaining = Math.max(0, budget - externalBytes);
            if (!remaining) {
                return { bytes: 0, count: 0 };
            }
            show('loading', '📦 正在用自有填充文件补齐…', '还需约 ' + formatBytes(remaining));
            return filler(remaining, id);
        }).then(function (fill) {
            var content = externalBytes + fill.bytes;
            var total = (pageBytes || FALLBACK) + OVERHEAD + content;
            var duration = ((new Date().getTime() - started) / 1000).toFixed(2);

            show('success', '✅ 本次测试完成',
                '目标 ' + formatBytes(target) +
                ' · 页面 ' + formatBytes(pageBytes || FALLBACK) +
                ' · 内容 ' + formatBytes(content) +
                ' · URL ' + chosen.length + ' 个' +
                (failed ? '；' + failed + ' 个不可读取，已补足' : '') +
                ' · ' + duration + ' 秒');

            saveHistory({
                date: new Date().toLocaleString('zh-CN', { hour12: false }),
                amount: label,
                totalBytes: total,
                urlCount: chosen.length,
                timestamp: new Date().getTime()
            });
            start.textContent = '🔄 再次测试';
        }, function (error) {
            show('error', '❌ 操作失败', error.message || '网络请求失败，请稍后重试');
        }).then(function () {
            busy = false;
            start.disabled = false;
            check.disabled = false;
            clear.disabled = false;
        });
    }

    function initialize() {
        window.ggAppStarted = true;
        amount.addEventListener('change', preview, false);
        start.addEventListener('click', consume, false);
        check.addEventListener('click', checkRoutes, false);
        clear.addEventListener('click', function () {
            input.value = '';
            updateSummary();
            routeSummary.textContent = '当前列表已临时清空；刷新后会重新读取 url.txt。';
            routeResults.textContent = '';
        }, false);
        input.addEventListener('input', updateSummary, false);
        preview();
        renderHistory();
        updateSummary();
        loadUrls();
    }

    try {
        initialize();
    } catch (error) {
        window.ggAppStarted = false;
        loading = false;
        start.disabled = false;
        budgetSummary.textContent = '页面脚本初始化失败：' + (error.message || '未知错误');
        routeSummary.textContent = '请刷新页面重试；如仍失败，请检查 Safari 是否允许 JavaScript。';
    }
}());
