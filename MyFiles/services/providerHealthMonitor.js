'use strict';

const os = require('os');
const logger = require('../utils/logger');
const providerHttp = require('../utils/providerHttp');
const { provider } = require('./animeHeavenProvider');

const WINDOW_SIZE = 100;
const CACHE_HIT_LATENCY_MS = 250;

function mean(values) {
  if (!values.length) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  return Number((sum / values.length).toFixed(2));
}

function parseMsFromText(text) {
  const raw = String(text || '');
  const m = raw.match(/(\d+(?:\.\d+)?)\s*ms/i);
  return m ? Number(m[1]) : null;
}

function isCloudflareLike(input) {
  const text = String(input || '').toLowerCase();
  return (
    text.includes('cloudflare') ||
    text.includes('cf-challenge') ||
    text.includes('just a moment') ||
    text.includes('attention required')
  );
}

function isTimeoutLike(input) {
  const text = String(input || '').toLowerCase();
  return text.includes('timeout') || text.includes('timed out') || text.includes('econnaborted') || text.includes('etimedout');
}

class ProviderHealthMonitor {
  constructor() {
    this.startedAt = Date.now();
    this.initialized = false;
    this.originalMethods = new Map();
    this.originalLoggerStream = null;
    this.originalLoggerStreamAttempt = null;
    this.reset();
  }

  reset() {
    this.metrics = {
      totalRequests: 0,
      activeRequests: 0,
      successCount: 0,
      failureCount: 0,
      currentFailures: 0,
      timeouts: 0,
      cloudflareDetections: 0,
      retries: 0,
      cacheChecks: 0,
      cacheHits: 0,
      streamAttempts: 0,
      streamSuccess: 0,
      subtitleAttempts: 0,
      subtitleSuccess: 0,
      searchAttempts: 0,
      searchSuccess: 0,
      lastSuccessfulRequest: null,
      lastFailure: null,
      lastErrorMessage: null,
      uptimeStart: Date.now(),
      recentLatencyMs: [],
      recentCpuPct: [],
      recentMemRss: [],
      perMethodLatency: {},
      perMethodSuccess: {},
      perMethodFailure: {},
      requestTimeline: [],
      recentEvents: [],
      requestKeySeen: new Map(),
    };
  }

  emitStructured(event, payload = {}, level = 'info') {
    const entry = {
      event,
      provider: 'animeheaven',
      at: new Date().toISOString(),
      ...payload,
    };

    this.metrics.recentEvents.push(entry);
    if (this.metrics.recentEvents.length > WINDOW_SIZE) this.metrics.recentEvents.shift();

    if (level === 'warn') logger.warn('[ProviderMonitor]', entry);
    else if (level === 'error') logger.error('[ProviderMonitor]', entry);
    else logger.info('[ProviderMonitor]', entry);
  }

  patchLogger() {
    if (this.originalLoggerStream || this.originalLoggerStreamAttempt) return;

    this.originalLoggerStream = typeof logger.stream === 'function' ? logger.stream.bind(logger) : null;
    this.originalLoggerStreamAttempt = typeof logger.streamAttempt === 'function' ? logger.streamAttempt.bind(logger) : null;

    const applyCounters = (meta) => {
      const row = meta || {};
      if (row.result === 'retry') this.metrics.retries += 1;
      if (Number(row.attempt || 0) > 1 && row.status === 'pending') this.metrics.retries += 1;
      if (row.cloudflareDetected === true) this.metrics.cloudflareDetections += 1;
      if (row.timedOut === true || row.timeoutStatus === true) this.metrics.timeouts += 1;

      const ms = Number(row.latencyMs || row.duration || 0);
      if (ms > 0) {
        this.metrics.recentLatencyMs.push(ms);
        if (this.metrics.recentLatencyMs.length > WINDOW_SIZE) this.metrics.recentLatencyMs.shift();
      }
    };

    logger.stream = (meta = {}) => {
      applyCounters(meta);
      if (this.originalLoggerStream) return this.originalLoggerStream(meta);
      return undefined;
    };

    logger.streamAttempt = (meta = {}) => {
      applyCounters(meta);
      if (this.originalLoggerStreamAttempt) return this.originalLoggerStreamAttempt(meta);
      return undefined;
    };
  }

  classifySuccess(method, result) {
    if (method === 'searchAnime') {
      return Array.isArray(result) && result.length > 0;
    }
    if (method === 'extractStreams') {
      const sources = Array.isArray(result && result.sources) ? result.sources : [];
      return sources.length > 0;
    }
    if (method === 'resolvePlayer') {
      return !!(result && !result.reason);
    }
    if (method === 'resolveEpisode') {
      return !!(result && result.episode);
    }
    if (method === 'getEpisodeList') {
      return Array.isArray(result) && result.length > 0;
    }
    if (method === 'getAnimeDetails') {
      return !!(result && (result.title || result.identifier || result.id));
    }
    return result !== null && result !== undefined;
  }

  recordMethodCounters(method, success) {
    this.metrics.perMethodSuccess[method] = this.metrics.perMethodSuccess[method] || 0;
    this.metrics.perMethodFailure[method] = this.metrics.perMethodFailure[method] || 0;
    if (success) this.metrics.perMethodSuccess[method] += 1;
    else this.metrics.perMethodFailure[method] += 1;
  }

  wrapProviderMethod(methodName) {
    if (this.originalMethods.has(methodName)) return;
    const original = provider[methodName];
    if (typeof original !== 'function') return;

    this.originalMethods.set(methodName, original.bind(provider));

    provider[methodName] = async (...args) => {
      const started = Date.now();
      const hrStart = process.hrtime.bigint();
      const cpuStart = process.cpuUsage();

      this.metrics.totalRequests += 1;
      this.metrics.activeRequests += 1;

      const requestKey = `${methodName}:${JSON.stringify(args)}`;
      this.metrics.cacheChecks += 1;
      const hasSeen = this.metrics.requestKeySeen.has(requestKey);

      if (methodName === 'searchAnime') this.metrics.searchAttempts += 1;
      if (methodName === 'extractStreams') {
        this.metrics.streamAttempts += 1;
        this.metrics.subtitleAttempts += 1;
      }

      try {
        const result = await original.apply(provider, args);
        const latencyMs = Date.now() - started;
        const success = this.classifySuccess(methodName, result);

        this.metrics.activeRequests = Math.max(0, this.metrics.activeRequests - 1);
        this.metrics.recentLatencyMs.push(latencyMs);
        if (this.metrics.recentLatencyMs.length > WINDOW_SIZE) this.metrics.recentLatencyMs.shift();

        this.metrics.perMethodLatency[methodName] = this.metrics.perMethodLatency[methodName] || [];
        this.metrics.perMethodLatency[methodName].push(latencyMs);
        if (this.metrics.perMethodLatency[methodName].length > WINDOW_SIZE) this.metrics.perMethodLatency[methodName].shift();

        this.recordMethodCounters(methodName, success);

        const mem = process.memoryUsage();
        this.metrics.recentMemRss.push(mem.rss);
        if (this.metrics.recentMemRss.length > WINDOW_SIZE) this.metrics.recentMemRss.shift();

        const cpu = process.cpuUsage(cpuStart);
        const elapsedMs = Number(process.hrtime.bigint() - hrStart) / 1e6;
        const cpuMs = (cpu.user + cpu.system) / 1000;
        const cpuPct = elapsedMs > 0 ? Number(((cpuMs / elapsedMs) * 100).toFixed(2)) : 0;
        this.metrics.recentCpuPct.push(cpuPct);
        if (this.metrics.recentCpuPct.length > WINDOW_SIZE) this.metrics.recentCpuPct.shift();

        if (success) {
          this.metrics.successCount += 1;
          this.metrics.currentFailures = 0;
          this.metrics.lastSuccessfulRequest = {
            at: new Date().toISOString(),
            method: methodName,
            latencyMs,
          };
        } else {
          this.metrics.failureCount += 1;
          this.metrics.currentFailures += 1;
          this.metrics.lastFailure = {
            at: new Date().toISOString(),
            method: methodName,
            reason: 'unsuccessful_result',
          };
        }

        if (methodName === 'searchAnime' && success) this.metrics.searchSuccess += 1;
        if (methodName === 'extractStreams' && success) this.metrics.streamSuccess += 1;

        if (methodName === 'extractStreams') {
          const subtitles = Array.isArray(result && result.subtitles) ? result.subtitles : [];
          if (subtitles.length > 0) this.metrics.subtitleSuccess += 1;
        }

        if (hasSeen && latencyMs <= CACHE_HIT_LATENCY_MS) this.metrics.cacheHits += 1;
        this.metrics.requestKeySeen.set(requestKey, Date.now());

        this.metrics.requestTimeline.push({
          at: new Date().toISOString(),
          method: methodName,
          latencyMs,
          success,
          activeRequests: this.metrics.activeRequests,
        });
        if (this.metrics.requestTimeline.length > WINDOW_SIZE) this.metrics.requestTimeline.shift();

        this.emitStructured('provider_request', {
          method: methodName,
          success,
          latencyMs,
          activeRequests: this.metrics.activeRequests,
          cacheCandidateSeenBefore: hasSeen,
          cacheHitCount: this.metrics.cacheHits,
          totalRequests: this.metrics.totalRequests,
        });

        return result;
      } catch (error) {
        const latencyMs = Date.now() - started;
        this.metrics.activeRequests = Math.max(0, this.metrics.activeRequests - 1);
        this.metrics.failureCount += 1;
        this.metrics.currentFailures += 1;

        const msg = error && (error.message || String(error));
        if (isTimeoutLike(msg) || isTimeoutLike(error && error.code)) this.metrics.timeouts += 1;
        if (isCloudflareLike(msg)) this.metrics.cloudflareDetections += 1;

        this.metrics.lastFailure = {
          at: new Date().toISOString(),
          method: methodName,
          reason: msg,
        };
        this.metrics.lastErrorMessage = msg;

        this.recordMethodCounters(methodName, false);

        this.emitStructured('provider_request', {
          method: methodName,
          success: false,
          latencyMs,
          activeRequests: this.metrics.activeRequests,
          error: msg,
          totalRequests: this.metrics.totalRequests,
        }, 'warn');

        throw error;
      }
    };
  }

  initialize() {
    if (this.initialized) return;
    this.patchLogger();

    [
      'searchAnime',
      'getAnimeDetails',
      'getEpisodeList',
      'resolveEpisode',
      'resolvePlayer',
      'extractStreams',
    ].forEach((method) => this.wrapProviderMethod(method));

    this.initialized = true;
    this.emitStructured('provider_monitor_initialized', {
      methodsWrapped: [...this.originalMethods.keys()],
    });
  }

  movingAverages() {
    const latencies = this.metrics.recentLatencyMs;
    const cpu = this.metrics.recentCpuPct;
    const rss = this.metrics.recentMemRss;

    return {
      latencyMs: {
        last10: mean(latencies.slice(-10)),
        last25: mean(latencies.slice(-25)),
        last100: mean(latencies.slice(-100)),
      },
      cpuPercent: {
        last10: mean(cpu.slice(-10)),
        last25: mean(cpu.slice(-25)),
        last100: mean(cpu.slice(-100)),
      },
      memoryRssMb: {
        last10: Number((mean(rss.slice(-10)) / 1024 / 1024).toFixed(2)),
        last25: Number((mean(rss.slice(-25)) / 1024 / 1024).toFixed(2)),
        last100: Number((mean(rss.slice(-100)) / 1024 / 1024).toFixed(2)),
      },
    };
  }

  getSnapshot() {
    const now = Date.now();
    const total = this.metrics.successCount + this.metrics.failureCount;
    const successRate = total > 0 ? Number(((this.metrics.successCount / total) * 100).toFixed(2)) : 0;
    const failureRate = total > 0 ? Number(((this.metrics.failureCount / total) * 100).toFixed(2)) : 0;
    const cacheHitRatio = this.metrics.cacheChecks > 0
      ? Number((this.metrics.cacheHits / this.metrics.cacheChecks).toFixed(4))
      : 0;

    const providerHealth = providerHttp.getHealthStats('animeheaven') || {};
    const providerSnapshot = typeof provider.getHealthSnapshot === 'function' ? provider.getHealthSnapshot() : {};

    const mem = process.memoryUsage();
    const load = os.loadavg();
    const avgResponseMs = parseMsFromText(providerHealth.avgResponseTime);

    const streamSuccessRate = this.metrics.streamAttempts > 0
      ? Number(((this.metrics.streamSuccess / this.metrics.streamAttempts) * 100).toFixed(2))
      : 0;
    const subtitleSuccessRate = this.metrics.subtitleAttempts > 0
      ? Number(((this.metrics.subtitleSuccess / this.metrics.subtitleAttempts) * 100).toFixed(2))
      : 0;
    const searchSuccessRate = this.metrics.searchAttempts > 0
      ? Number(((this.metrics.searchSuccess / this.metrics.searchAttempts) * 100).toFixed(2))
      : 0;

    const status = this.metrics.currentFailures >= 5
      ? 'degraded'
      : (this.metrics.activeRequests > 20 ? 'busy' : 'healthy');

    return {
      provider: 'animeheaven',
      status,
      startedAt: new Date(this.metrics.uptimeStart).toISOString(),
      uptimeSeconds: Math.floor((now - this.metrics.uptimeStart) / 1000),
      uptimePercentage: Number(providerHealth.uptimePercentage || successRate),
      latency: {
        avgResponseMs: avgResponseMs || Number(providerSnapshot.avgResponseMs || 0),
        movingAverages: this.movingAverages().latencyMs,
      },
      successRate,
      failureRate,
      lastSuccessfulRequest: this.metrics.lastSuccessfulRequest,
      currentFailures: this.metrics.currentFailures,
      movingAverages: this.movingAverages(),
      counts: {
        totalRequests: this.metrics.totalRequests,
        successCount: this.metrics.successCount,
        failureCount: this.metrics.failureCount,
        activeRequests: this.metrics.activeRequests,
        retries: this.metrics.retries,
        timeouts: this.metrics.timeouts,
        cloudflareDetections: this.metrics.cloudflareDetections,
      },
      cache: {
        checks: this.metrics.cacheChecks,
        hits: this.metrics.cacheHits,
        hitRatio: cacheHitRatio,
      },
      memory: {
        rssMb: Number((mem.rss / 1024 / 1024).toFixed(2)),
        heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
        heapTotalMb: Number((mem.heapTotal / 1024 / 1024).toFixed(2)),
      },
      cpu: {
        loadAverage: {
          oneMinute: Number(load[0].toFixed(2)),
          fiveMinutes: Number(load[1].toFixed(2)),
          fifteenMinutes: Number(load[2].toFixed(2)),
        },
        movingAveragePercent: this.movingAverages().cpuPercent,
      },
      rates: {
        streamSuccessRate,
        subtitleSuccessRate,
        searchSuccessRate,
      },
      providerHttpHealth: providerHealth,
      providerSnapshot,
      recentEvents: this.metrics.recentEvents.slice(-25),
    };
  }
}

const monitor = new ProviderHealthMonitor();

module.exports = monitor;
