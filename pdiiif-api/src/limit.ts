import crypto from 'crypto';

import { Response } from 'express';
import mnemonist from 'mnemonist';
import IPCIDR from 'ip-cidr';
import { BigInteger } from 'jsbn';

import log from './logger.js';

export type RateLimitInfo = {
  limited: boolean;
  total: number;
  remaining: number;
  retryIn: number;
  resetIn: number;
  burst: number;
};

export type RateLimitArgs = {
  // Key to limit
  key: string;
  // Max number of burstable tokens, after this amount has been reached, regeneration stops
  burst: number;
  // Rate at which available tokens regenerate over the given `period`
  rate: number;
  // Period in milliseconds in which tokens are regenerated at `rate`
  period: number;
  // Cost associated with the operation, i.e. this many tokens are consumed
  cost: number;
};

interface RateLimitState {
  throttleAt: number;
  expireAt: number;
}

export type RateLimiterOptions = {
  exceptions?: Array<string>;
  defaults: {
    pdf: Omit<Partial<RateLimitArgs>, 'key'>;
    cover: Omit<Partial<RateLimitArgs>, 'key'>;
  };
};

export class RateLimiter {
  store: Map<string, RateLimitState> = new Map();
  retryAfterViolations: Map<string, number> = new Map();
  exceptions?: mnemonist.StaticIntervalTree<string>;
  defaults: {
    pdf: Omit<Partial<RateLimitArgs>, 'key'>;
    cover: Omit<Partial<RateLimitArgs>, 'key'>;
  };

  constructor({ exceptions, defaults }: RateLimiterOptions) {
    this.defaults = defaults;
    if (exceptions?.length) {
      this.exceptions = new mnemonist.StaticIntervalTree(exceptions, [
        // FIXME: Probably broken for IPv6, there's a reason the library uses a BigInteger and not a number
        (cidr) =>
          new IPCIDR(cidr).start<BigInteger>({ type: 'bigInteger' }).intValue(),
        (cidr) =>
          new IPCIDR(cidr).end<BigInteger>({ type: 'bigInteger' }).intValue(),
      ]);
    }
  }

  isThrottledClientMisbehaving(clientIp: string): boolean {
    const violations = this.retryAfterViolations.get(clientIp) ?? -1;
    this.retryAfterViolations.set(clientIp, violations + 1);
    return violations >= 2;
  }

  throttle(
    clientIp: string,
    operation: 'pdf' | 'cover',
    res: Response
  ): boolean {
    const ipNum = new IPCIDR(`${clientIp}/32`)
      .start<BigInteger>({ type: 'bigInteger' })
      .intValue();
    const exception = this.exceptions?.intervalsContainingPoint(ipNum);
    const key = crypto
      .createHash('sha256')
      .update(operation)
      .update(clientIp)
      .digest('hex');

    if (!exception) {
      const defaults = this.defaults[operation];
      const rateLimitInfo = this.performRateLimiting({
        key,
        burst: defaults.burst ?? 1,
        rate: defaults.rate ?? 1,
        period: defaults.period ?? 1000,
        cost: defaults.cost ?? 1,
      });
      res.setHeader(
        'RateLimit-Limit',
        `${rateLimitInfo.total};w=${24 * 60 * 60};burst=${
          rateLimitInfo.burst
        };policy="generic cell rate algorithm"`
      );
      res.setHeader('RateLimit-Remaining', rateLimitInfo.remaining);
      res.setHeader(
        'RateLimit-Reset',
        Math.round(rateLimitInfo.resetIn / 1000)
      );
      if (rateLimitInfo.limited) {
        const isMisbehaving = this.isThrottledClientMisbehaving(clientIp);
        if (isMisbehaving) {
          setTimeout(() => {
            res.setHeader('Retry-After', '1');
            res.status(429).send();
          }, rateLimitInfo.retryIn);
          return true;
        }
        res.setHeader('Retry-After', Math.round(rateLimitInfo.retryIn / 1000));
        res.status(429).send({
          message:
            'Too many requests, please respect the rate limits listed in the headers. For an exception, contact the ' +
            "provider of this API. Don't perform any more requests before the time set by Retry-After has expired, " +
            'or your requests will be made to wait.',
          rateLimitInfo,
        });
        log.warn(
          'Rate-limited client due to exceeded quota for PDF generation',
          {
            clientAddr: clientIp,
          }
        );
        return true;
      }
    }
    // No rate limiting, client is exempt due to explicit exception
    // TODO: Make this more fine-grained to prevent (accidental) abuse by whitelisted partners
    return false;
  }

  /**
   * Rate-limit a call using the CGRA algorithm.
   *
   * Code ported from Lua code at https://github.com/Losant/redis-gcra/blob/master/lib/gcra.lua
   *
   * MIT License
   *
   * Copyright (c) 2020 Losant
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   */
  private performRateLimiting({
    key,
    burst,
    rate,
    period,
    cost,
  }: RateLimitArgs): RateLimitInfo {
    const now = Date.now();
    const emissionInterval = period / rate;
    const increment = emissionInterval * cost;
    const burstOffset = emissionInterval * burst;

    let throttleAt: number;
    const entry = this.store.get(key);
    if (entry === undefined || entry.expireAt >= now) {
      throttleAt = now;
    } else {
      throttleAt = entry.throttleAt;
    }
    throttleAt = Math.max(throttleAt, now);
    const newThrottleAt = throttleAt + increment;
    const allowAt = newThrottleAt - burstOffset;
    const diff = now - allowAt;

    let limited: boolean;
    let retryIn: number;
    let resetIn: number;

    let remaining = Math.round(diff / emissionInterval);

    if (remaining < 0) {
      limited = true;
      remaining = Math.floor(
        (now - (throttleAt - burstOffset)) / emissionInterval
      );
      resetIn = Math.ceil(throttleAt - now);
      retryIn = Math.ceil(diff * -1);
    } else if (remaining === 0 && increment <= 0) {
      limited = true;
      remaining = 0;
      resetIn = Math.ceil(throttleAt - now);
      retryIn = 0;
    } else {
      limited = false;
      resetIn = Math.ceil(newThrottleAt - now);
      retryIn = 0;
      if (increment > 0) {
        this.store.set(key, {
          throttleAt: newThrottleAt,
          expireAt: resetIn,
        });
      }
    }
    return { limited, total: rate, burst, remaining, retryIn, resetIn };
  }
}
