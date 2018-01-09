import { IBackoffStrategy } from './backoff/backoff';
import { ExponentialBackoff } from './backoff/exponential';
import { Host } from './host';
import { RequestError, ServiceNotAvailableError } from './results';

import * as http from 'http';
import * as https from 'https';
import * as querystring from 'querystring';
import * as urlModule from 'url';

/**
 * Status codes that will cause a host to be marked as 'failed' if we get
 * them from a request to Kapacitor.
 * @type {Array}
 */
const resubmitErrorCodes = [
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
];

export interface IPoolOptions {

  /**
   * Number of times we should retry running a query
   * before calling back with an error.
   */
  maxRetries?: number;

  /**
   * The length of time after which HTTP requests will error
   * if they do not receive a response.
   */
  requestTimeout?: number;

  /**
   * Options to configure the backoff policy for the pool. Defaults
   * to using exponential backoff.
   */
  backoff: IBackoffStrategy;

}

export interface IPoolRequestOptions {

  /**
   * Request method.
   */
  method: 'GET' | 'POST' | 'DELETE';

  /**
   * Path to hit on the database server, must begin with a leading slash.
   */
  path: string;

  /**
   * Query string to be appended to the request path.
   */
  query?: any;

  /**
   * Request body to include.
   */
  body?: string;

  /**
   * For internal use only, a counter of the number of times we've retried
   * running this request.
   */
  retries?: number;

}

/**
 * Creates a function generation that returns a wrapper which only allows
 * through the first call of any function that it generated.
 */
function doOnce(): (<T>(arg: any) => ((arg: T) => any)) {
  let handled = false;

  return fn => {
    return arg => {
      if (handled) {
        return;
      }
      handled = true;
      fn(arg);
    };
  };
}

export interface IPingStats {
  url: urlModule.Url;
  res: http.IncomingMessage | null;
  online: boolean;
  rtt: number;
  version: string | null;
}

function setToArray<T>(itemSet: Set<T>): T[] {
  const output: T[] = [];
  itemSet.forEach(value => {
    output.push(value);
  });

  return output;
}

const request = (
  options: http.RequestOptions,
  callback: (res: http.IncomingMessage) => void,
): http.ClientRequest => {
  if (options.protocol === 'https:') {
    return https.request(options, callback);
  } else {
    return http.request(options, callback);
  }
};

/**
 *
 * The Pool maintains a list available Kapacitor hosts and dispatches requests
 * to them. If there are errors connecting to hosts, it will disable that
 * host for a period of time.
 */
export class Pool {

  private options: IPoolOptions;
  private index: number;
  private timeout: number;

  private hostsAvailable: Set<Host>;
  private hostsDisabled: Set<Host>;

  /**
   * Creates a new Pool instance.
   * @param {IPoolOptions} options
   */
  constructor (options?: IPoolOptions) {
    this.options = Object.assign({
      backoff: new ExponentialBackoff({
        initial: 300,
        max: 10 * 1000,
        random: 1,
      }),
      maxRetries: 2,
      requestTimeout: 30 * 1000,
    }, options);

    this.index = 0;
    this.hostsAvailable = new Set<Host>();
    this.hostsDisabled = new Set<Host>();
    this.timeout = <number>this.options.requestTimeout;
  }

  /**
   * Returns a list of currently active hosts.
   * @return {Host[]}
   */
  public getHostsAvailable(): Host[] {
    return setToArray(this.hostsAvailable);
  }

  /**
   * Returns a list of hosts that are currently disabled due to network
   * errors.
   * @return {Host[]}
   */
  public getHostsDisabled(): Host[] {
    return setToArray(this.hostsDisabled);
  }

  /**
   * Inserts a new host to the pool.
   */
  public addHost(url: string, options: https.RequestOptions = {}): Host {
    const host = new Host(url, this.options.backoff.reset(), options);
    this.hostsAvailable.add(host);
    return host;
  }

  /**
   * Returns true if there's any host available to by queried.
   * @return {Boolean}
   */
  public hostIsAvailable(): boolean {
    return this.hostsAvailable.size > 0;
  }

  /**
   * Makes a request and calls back with the response, parsed as JSON.
   * An error is returned on a non-2xx status code or on a parsing exception.
   */
  public async json(options: IPoolRequestOptions): Promise<any> {
    const res = await this.text(options);
    if (res) {
      return JSON.parse(res);
    }

    return res;
  }

  /**
   * Makes a request and resolves with the plain text response,
   * if possible. An error is raised on a non-2xx status code.
   */
  public text(options: IPoolRequestOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      this.stream(options, (err, res) => {
        if (err) {
          return reject(err);
        }

        let output = '';
        if (res) {
          res.on('data', str => output = output + str.toString());
          res.on('end', () => resolve(output));
        }
      });
    });
  }

  /**
   * Makes a request and discards any response body it receives.
   * An error is returned on a non-2xx status code.
   */
  public discard(options: IPoolRequestOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.stream(options, (err, res) => {
        if (err) {
          return reject(err);
        }

        if (res) {
          res.on('data', () => { /* ignore */ });
          res.on('end', () => resolve());
        }
      });
    });
  }

  /**
   * Ping sends out a request to all available Kapacitor servers, reporting on
   * their response time and version number.
   */
  public ping(timeout: number, path: string = '/kapacitor/v1/ping'): Promise<IPingStats[]> {
    const todo: Promise<IPingStats>[] = [];

    setToArray(this.hostsAvailable)
      .concat(setToArray(this.hostsDisabled))
      .forEach(host => {
        const start = Date.now();
        const url = host.url;
        const once = doOnce();

        return todo.push(new Promise(resolve => {
          const req = request(Object.assign({
            hostname: url.hostname,
            method: 'GET',
            path,
            port: Number(url.port),
            protocol: url.protocol,
            timeout,
          }, host.options), once((res: http.IncomingMessage) => {
            resolve({
              url,
              res,
              online: Number(res.statusCode) < 300,
              rtt: Date.now() - start,
              version: String(res.headers['x-kapacitor-version']),
            });
          }));

          const fail = once(() => {
            resolve({
              online: false,
              res: null,
              rtt: Infinity,
              url,
              version: null,
            });
          });

          req.on('timeout', fail);
          req.on('error', fail);
          req.end();
        }));
      });

    return Promise.all(todo);
  }

  /**
   * Makes a request and calls back with the IncomingMessage stream,
   * if possible. An error is returned on a non-2xx status code.
   */
  public stream(
    options: IPoolRequestOptions,
    callback: (err: Error | undefined, res: http.IncomingMessage | null) => void,
  ) {
    if (!this.hostIsAvailable()) {
      return callback(new ServiceNotAvailableError('No host available'), null);
    }

    let path = options.path;
    if (options.query) {
      path += '?' + querystring.stringify(options.query);
    }

    const once = doOnce();
    const host = this.getHost();
    const req = request(Object.assign({
      headers: { 'content-length': options.body ? new Buffer(options.body).length : 0 },
      hostname: host.url.hostname,
      method: options.method,
      path,
      port: Number(host.url.port),
      protocol: host.url.protocol,
      timeout: this.timeout,
    }, host.options), once((res: http.IncomingMessage) => {
      if (Number(res.statusCode) >= 300) {
        return RequestError.Create(req, res, err => callback(err, res));
      }

      host.success();
      return callback(undefined, res);
    }));

    // Handle network or HTTP parsing errors:
    req.on('error', once((err: Error) => {
      this.handleRequestError(err, host, options, callback);
    }));

    // Handle timeouts:
    req.on('timeout', once(() => {
      this.handleRequestError(
        new ServiceNotAvailableError('Request timed out'),
        host, options, callback,
      );
    }));

    // Support older Nodes and polyfills which don't allow .timeout() in the
    // request options, wrapped in a conditional for even worse polyfills. See:
    if (typeof req.setTimeout === 'function') {
      req.setTimeout(this.timeout); // tslint:disable-line
    }

    // Write out the body:
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  }

  /**
   * Returns the next available host for querying.
   * @return {Host}
   */
  private getHost(): Host {
    const available = setToArray(this.hostsAvailable);
    const host = available[this.index];
    this.index = (this.index + 1) % available.length;
    return host;
  }

  /**
   * Re-enables the provided host, returning it to the pool to query.
   * @param  {Host} host
   */
  private enableHost(host: Host) {
    this.hostsDisabled.delete(host);
    this.hostsAvailable.add(host);
  }

  /**
   * Disables the provided host, removing it from the query pool. It will be
   * re-enabled after a backoff interval
   */
  private disableHost(host: Host) {
    this.hostsAvailable.delete(host);
    this.hostsDisabled.add(host);
    this.index %= Math.max(1, this.hostsAvailable.size);

    setTimeout(() => this.enableHost(host), host.fail());
  }

  private handleRequestError (
    err: any, host: Host,
    options: IPoolRequestOptions,
    callback: (err: Error | undefined, res: http.IncomingMessage | null) => void,
  ) {
    if (!(err instanceof ServiceNotAvailableError) &&
        resubmitErrorCodes.indexOf(err.code) === -1) {
      return callback(err, null);
    }

    this.disableHost(host);
    const retries = options.retries || 0;
    if (retries < Number(this.options.maxRetries) && this.hostIsAvailable()) {
      options.retries = retries + 1;
      return this.stream(options, callback);
    }

    callback(err, null);
  }

}
