(() => {
  const STORAGE_KEY = 'chat-download-settings';
  const DEFAULTS = {
    enabled: true,
    concurrency: 6,
    chunkSize: 8 * 1024 * 1024
  };
  let cache = null;

  function parseSettings(raw) {
    if (!raw) return { ...DEFAULTS };
    try {
      const parsed = JSON.parse(raw);
      return {
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
        concurrency: clamp(
          Number(parsed.concurrency) || DEFAULTS.concurrency,
          1,
          64
        ),
        chunkSize: clamp(
          Number(parsed.chunkSize) || DEFAULTS.chunkSize,
          128 * 1024,
          128 * 1024 * 1024
        )
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function load() {
    if (cache) return { ...cache };
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    cache = parseSettings(raw);
    return { ...cache };
  }

  function save(next) {
    cache = {
      ...load(),
      ...next
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent('downloadsettingschange', { detail: { ...cache } }));
    return { ...cache };
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value)) return '未知大小';
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let idx = -1;
    let result = value;
    do {
      result /= 1024;
      idx += 1;
    } while (result >= 1024 && idx < units.length - 1);
    return `${result.toFixed(result >= 100 ? 0 : result >= 10 ? 1 : 2)} ${units[idx]}`;
  }

  class HighSpeedDownloader {
    constructor(options) {
      const settings = load();
      this.url = options.url;
      this.size = Number(options.size) || 0;
      this.fileName = options.fileName || 'download.bin';
      this.contentType = options.contentType || 'application/octet-stream';
      this.concurrency = clamp(
        Number(options.concurrency) || settings.concurrency || 4,
        1,
        8
      );
      this.chunkSize = clamp(
        Number(options.chunkSize) || settings.chunkSize || DEFAULTS.chunkSize,
        128 * 1024,
        8 * 1024 * 1024
      );
      this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
      this.controller = new AbortController();
      this.retryCount = 3;
      this.baseRetryDelay = 600;
    }

    static isSupported() {
      return typeof fetch === 'function' && typeof Blob !== 'undefined';
    }

    static async downloadFromSignedUrl(meta) {
      const settings = load();
      const downloader = new HighSpeedDownloader({
        url: meta.url,
        size: meta.size,
        fileName: meta.fileName,
        contentType: meta.contentType,
        concurrency: settings.concurrency,
        chunkSize: settings.chunkSize
      });
      return downloader.start();
    }

    static async downloadFromUrl(url, options = {}) {
      const settings = load();
      const downloader = new HighSpeedDownloader({
        url,
        size: options.size || 0,
        fileName: options.fileName || deriveFileName(url),
        contentType: options.contentType,
        concurrency: settings.concurrency,
        chunkSize: settings.chunkSize
      });
      return downloader.start();
    }

    async start() {
      if (!HighSpeedDownloader.isSupported()) {
        throw new Error('当前环境不支持 fetch / Blob，无法使用高速下载。');
      }
      const size = await this.ensureSize();
      if (!size || size < this.chunkSize || this.concurrency === 1) {
        return this.singleFetch();
      }
      return this.multiFetch(size);
    }

    async ensureSize() {
      if (this.size > 0) return this.size;
      try {
        const res = await fetch(this.url, {
          method: 'HEAD',
          signal: this.controller.signal
        });
        if (!res.ok) return 0;
        const len = res.headers.get('content-length');
        const parsed = Number(len);
        this.contentType =
          this.contentType || res.headers.get('content-type') || 'application/octet-stream';
        if (Number.isFinite(parsed) && parsed > 0) {
          this.size = parsed;
          return parsed;
        }
      } catch {
        /* ignore */
      }
      return 0;
    }

    async singleFetch() {
      const res = await fetch(this.url, {
        method: 'GET',
        signal: this.controller.signal
      });
      if (!res.ok) {
        throw new Error(`下载失败：HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const finalBlob =
        this.contentType && this.contentType !== blob.type
          ? new Blob([blob], { type: this.contentType })
          : blob;
      triggerDownload(finalBlob, this.fileName);
      return true;
    }

    async multiFetch(size) {
      const totalChunks = Math.ceil(size / this.chunkSize);
      const ranges = [];
      for (let i = 0; i < totalChunks; i += 1) {
        const start = i * this.chunkSize;
        const end = Math.min(size - 1, start + this.chunkSize - 1);
        ranges.push({ index: i, start, end });
      }
      const results = new Array(totalChunks);
      let completed = 0;

      const queue = ranges.slice();
      const workers = new Array(Math.min(this.concurrency, totalChunks))
        .fill(null)
        .map(() =>
          this.spawnWorker(queue, results, () => {
            completed += 1;
            this.onProgress({
              completed,
              total: totalChunks,
              percent: Math.min(100, Math.round((completed / totalChunks) * 100))
            });
          })
        );

      await Promise.all(workers);

      const blob = new Blob(results, { type: this.contentType });
      triggerDownload(blob, this.fileName);
      return true;
    }

    async spawnWorker(queue, results, report) {
      while (queue.length) {
        const task = queue.shift();
        if (!task) break;
        const buffer = await this.fetchRangeWithRetry(task.start, task.end);
        results[task.index] = buffer;
        report();
      }
    }

    async fetchRangeWithRetry(start, end, attempt = 1) {
      try {
        return await this.fetchRange(start, end);
      } catch (error) {
        if (attempt >= this.retryCount) {
          throw error;
        }
        const delay = this.baseRetryDelay * attempt;
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.fetchRangeWithRetry(start, end, attempt + 1);
      }
    }

    async fetchRange(start, end) {
      const res = await fetch(this.url, {
        method: 'GET',
        headers: { Range: `bytes=${start}-${end}` },
        signal: this.controller.signal
      });

      if (res.status === 206) {
        const buf = await res.arrayBuffer();
        if (buf.byteLength === end - start + 1) return buf;
        throw new Error('服务器返回的分片长度不匹配。');
      }

      if (res.ok && res.status === 200) {
        const buf = await res.arrayBuffer();
        if (buf.byteLength === end - start + 1) return buf;
      }

      throw new Error(`服务器不支持 Range 请求或分片响应异常（HTTP ${res.status}）。`);
    }

    cancel() {
      this.controller.abort();
    }
  }

  function deriveFileName(url) {
    try {
      const parsed = new URL(url);
      const base = parsed.pathname.split('/').pop() || 'download.bin';
      return decodeURIComponent(base);
    } catch {
      return 'download.bin';
    }
  }

  function triggerDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  window.DownloadSettings = {
    get: load,
    set: save,
    formatBytes
  };

  window.HighSpeedDownloader = HighSpeedDownloader;
})();
