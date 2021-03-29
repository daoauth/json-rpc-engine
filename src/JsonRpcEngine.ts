import SafeEventEmitter from '@metamask/safe-event-emitter';
import { errorCodes, EthereumRpcError, serializeError } from 'eth-rpc-errors';
import { isValidCode } from 'eth-rpc-errors/dist/utils';

type Maybe<T> = Partial<T> | null | undefined;

export type Json =
  | boolean
  | number
  | string
  | null
  | { [property: string]: Json }
  | Json[];

/**
 * A String specifying the version of the JSON-RPC protocol.
 * MUST be exactly "2.0".
 */
export type JsonRpcVersion = '2.0';

/**
 * An identifier established by the Client that MUST contain a String, Number,
 * or NULL value if included. If it is not included it is assumed to be a
 * notification. The value SHOULD normally not be Null and Numbers SHOULD
 * NOT contain fractional parts.
 */
export type JsonRpcId = number | string | void;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
  stack?: string;
}

export interface JsonRpcRequest<T> {
  jsonrpc: JsonRpcVersion;
  method: string;
  id: JsonRpcId;
  params?: T;
}

export interface JsonRpcNotification<T> {
  jsonrpc: JsonRpcVersion;
  method: string;
  params?: T;
}

interface JsonRpcResponseBase {
  jsonrpc: JsonRpcVersion;
  id: JsonRpcId;
}

export interface JsonRpcSuccess<T> extends JsonRpcResponseBase {
  result: Maybe<T>;
}

export interface JsonRpcFailure extends JsonRpcResponseBase {
  error: JsonRpcError;
}

export type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

export interface PendingJsonRpcResponse<T> extends JsonRpcResponseBase {
  result?: T;
  error?: Error | JsonRpcError;
}

export type JsonRpcEngineCallbackError = Error | JsonRpcError | null;

type MaybePromise<T> = Promise<T> | T;

export type JsonRpcEngineReturnHandler = () => MaybePromise<void>;

export type JsonRpcEngineEndCallback = () => void;

export type JsonRpcMiddleware<T, U> = (
  req: JsonRpcRequest<T>,
  res: PendingJsonRpcResponse<U>,
  end: JsonRpcEngineEndCallback
) => MaybePromise<void | JsonRpcEngineReturnHandler>;

const errorMessages = {
  invalidReturnHandler: (value: unknown) => `JsonRpcEngine: Return handlers must be functions. Received: ${typeof value}.`,
  noAssignmentToResponse: `JsonRpcEngine: The response "error" property must not be directly assigned. Throw errors instead.`,
  noErrorOrResult: `JsonRpcEngine: Response has no error or result`,
  noErrorsToEnd: `JsonRpcEngine: "end" callback must not be passed any values. Received an error. Throw errors instead.`,
  nonObjectRequest: (request: unknown) => `Requests must be plain objects. Received: ${typeof request}`,
  nonStringMethod: (method: unknown) => `Must specify a string method. Received: ${typeof method}`,
  noValuesToEnd: (value: unknown) => `JsonRpcEngine: "end" callback must not be passed any values. Received: ${typeof value}.`,
  nothingEndedRequest: `JsonRpcEngine: Nothing ended request.`,
  threwNonError: `JsonRpcEngine: Middleware threw non-Error value.`,
};

/**
 * A JSON-RPC request and response processor.
 * Give it a stack of middleware, pass it requests, and get back responses.
 */
export class JsonRpcEngine extends SafeEventEmitter {
  private _middleware: JsonRpcMiddleware<unknown, unknown>[];

  constructor() {
    super();
    this._middleware = [];
  }

  /**
   * Add a middleware function to the engine's middleware stack.
   *
   * @param middleware - The middleware function to add.
   */
  push<T, U>(middleware: JsonRpcMiddleware<T, U>): void {
    this._middleware.push(middleware as JsonRpcMiddleware<unknown, unknown>);
  }

  /**
   * Handle a JSON-RPC request, and return a response.
   *
   * @param request - The request to handle.
   * @param callback - An error-first callback that will receive the response.
   */
  handle<T, U>(
    request: JsonRpcRequest<T>,
    callback: (error: unknown, response: JsonRpcResponse<U>) => void,
  ): void;

  /**
   * Handle an array of JSON-RPC requests, and return an array of responses.
   *
   * @param request - The requests to handle.
   * @param callback - An error-first callback that will receive the array of
   * responses.
   */
  handle<T, U>(
    requests: JsonRpcRequest<T>[],
    callback: (error: unknown, responses: JsonRpcResponse<U>[]) => void,
  ): void;

  /**
   * Handle a JSON-RPC request, and return a response.
   *
   * @param request - The request to handle.
   * @returns A promise that resolves with the response, or rejects with an
   * error.
   */
  handle<T, U>(request: JsonRpcRequest<T>): Promise<JsonRpcResponse<U>>;

  /**
   * Handle an array of JSON-RPC requests, and return an array of responses.
   *
   * @param request - The requests to handle.
   * @returns A promise that resolves with the array of responses, or rejects
   * with an error.
   */
  handle<T, U>(requests: JsonRpcRequest<T>[]): Promise<JsonRpcResponse<U>[]>;

  handle(req: unknown, cb?: any) {
    if (cb && typeof cb !== 'function') {
      throw new Error('"callback" must be a function if provided.');
    }

    if (Array.isArray(req)) {
      if (cb) {
        return this._handleBatch(req, cb);
      }
      return this._handleBatch(req);
    }

    if (cb) {
      return this._handle(req as JsonRpcRequest<unknown>, cb);
    }
    return this._promiseHandle(req as JsonRpcRequest<unknown>);
  }

  /**
   * Returns this engine as a middleware function that can be pushed to other
   * engines.
   *
   * @returns This engine as a middleware function.
   */
  asMiddleware(): JsonRpcMiddleware<unknown, unknown> {
    return async (req, res, end) => {
      const [
        middlewareError,
        isComplete,
        returnHandlers,
      ] = await JsonRpcEngine._runAllMiddleware(req, res, this._middleware);

      if (isComplete) {
        await JsonRpcEngine._runReturnHandlers(returnHandlers);
        if (middlewareError) {
          throw middlewareError;
        }
        return end();
      }

      return async () => {
        await JsonRpcEngine._runReturnHandlers(returnHandlers);
      };
    };
  }

  /**
   * Like _handle, but for batch requests.
   */
  private _handleBatch(
    reqs: JsonRpcRequest<unknown>[],
  ): Promise<JsonRpcResponse<unknown>[]>;

  /**
   * Like _handle, but for batch requests.
   */
  private _handleBatch(
    reqs: JsonRpcRequest<unknown>[],
    cb: (error: unknown, responses?: JsonRpcResponse<unknown>[]) => void,
  ): Promise<void>;

  private async _handleBatch(
    reqs: JsonRpcRequest<unknown>[],
    cb?: (error: unknown, responses?: JsonRpcResponse<unknown>[]) => void,
  ): Promise<JsonRpcResponse<unknown>[] | void> {
    // The order here is important
    try {
      // 2. Wait for all requests to finish, or throw on some kind of fatal
      // error
      const responses = await Promise.all(
        // 1. Begin executing each request in the order received
        reqs.map(this._promiseHandle.bind(this)),
      );

      // 3. Return batch response
      if (cb) {
        return cb(null, responses);
      }
      return responses;
    } catch (error) {
      if (cb) {
        return cb(error);
      }

      throw error;
    }
  }

  /**
   * A promise-wrapped _handle.
   */
  private _promiseHandle(
    req: JsonRpcRequest<unknown>,
  ): Promise<JsonRpcResponse<unknown>> {
    return new Promise((resolve) => {
      this._handle(req, (_err, res) => {
        // There will always be a response, and it will always have any error
        // that is caught and propagated.
        resolve(res);
      });
    });
  }

  /**
   * Ensures that the request object is valid, processes it, and passes any
   * error and the response object to the given callback.
   *
   * Does not reject.
   */
  private async _handle(
    callerReq: JsonRpcRequest<unknown>,
    cb: (error: unknown, response: JsonRpcResponse<unknown>) => void,
  ): Promise<void> {
    if (
      !callerReq ||
      Array.isArray(callerReq) ||
      typeof callerReq !== 'object'
    ) {
      const error = new EthereumRpcError(
        errorCodes.rpc.invalidRequest,
        errorMessages.nonObjectRequest(callerReq),
        { request: callerReq },
      );
      return cb(error, { id: undefined, jsonrpc: '2.0', error });
    }

    if (typeof callerReq.method !== 'string') {
      const error = new EthereumRpcError(
        errorCodes.rpc.invalidRequest,
        errorMessages.nonStringMethod(callerReq.method),
        { request: callerReq },
      );
      return cb(error, { id: callerReq.id, jsonrpc: '2.0', error });
    }

    const req: JsonRpcRequest<unknown> = { ...callerReq };
    const res: PendingJsonRpcResponse<unknown> = {
      id: req.id,
      jsonrpc: req.jsonrpc,
    };
    let error: JsonRpcEngineCallbackError = null;

    try {
      await this._processRequest(req, res);
    } catch (_error) {
      // A request handler error, a re-thrown middleware error, or something
      // unexpected.
      error = _error;
    }

    if (error) {
      // Ensure no result is present on an errored response
      delete res.result;
      if (!res.error) {
        res.error = serializeError(error);
      }
    }

    return cb(error, res as JsonRpcResponse<unknown>);
  }

  /**
   * For the given request and response, runs all middleware and their return
   * handlers, if any, and ensures that internal request processing semantics
   * are satisfied.
   */
  private async _processRequest(
    req: JsonRpcRequest<unknown>,
    res: PendingJsonRpcResponse<unknown>,
  ): Promise<void> {
    const [
      error,
      isComplete,
      returnHandlers,
    ] = await JsonRpcEngine._runAllMiddleware(req, res, this._middleware);

    // Throw if "end" was not called, or if the response has neither a result
    // nor an error.
    JsonRpcEngine._checkForCompletion(req, res, isComplete);

    // The return handlers should run even if an error was encountered during
    // middleware processing.
    await JsonRpcEngine._runReturnHandlers(returnHandlers);

    // Now we re-throw the middleware processing error, if any, to catch it
    // further up the call chain.
    if (error) {
      throw error;
    }
  }

  /**
   * Serially executes the given stack of middleware.
   *
   * @returns An array of any error encountered during middleware execution,
   * a boolean indicating whether the request was completed, and an array of
   * middleware-defined return handlers.
   */
  private static async _runAllMiddleware(
    req: JsonRpcRequest<unknown>,
    res: PendingJsonRpcResponse<unknown>,
    middlewareStack: JsonRpcMiddleware<unknown, unknown>[],
  ): Promise<
    [
      unknown, // error
      boolean, // isComplete
      JsonRpcEngineReturnHandler[],
    ]
    > {
    const returnHandlers: JsonRpcEngineReturnHandler[] = [];
    let error = null;
    let isComplete = false;

    // Go down stack of middleware, call and collect optional returnHandlers
    for (const middleware of middlewareStack) {
      [error, isComplete] = await JsonRpcEngine._runMiddleware(
        req,
        res,
        middleware,
        returnHandlers,
      );
      if (isComplete) {
        break;
      }
    }
    return [error, isComplete, returnHandlers.reverse()];
  }

  /**
   * Runs an individual middleware.
   *
   * @returns An array of any error encountered during middleware exection,
   * and a boolean indicating whether the request should end.
   */
  private static async _runMiddleware(
    req: JsonRpcRequest<unknown>,
    res: PendingJsonRpcResponse<unknown>,
    middleware: JsonRpcMiddleware<unknown, unknown>,
    returnHandlers: JsonRpcEngineReturnHandler[],
  ): Promise<[unknown, boolean]> {
    const [
      middlewareCallbackPromise,
      resolve,
    ] = getDeferredPromise<[unknown, boolean]>();

    let endCalled = false;
    const end: JsonRpcEngineEndCallback = (arg?: unknown) => {
      JsonRpcEngine._validateEndState(req, res, arg);
      endCalled = true;
      resolve([null, true]);
    };

    try {
      const returnHandler = await middleware(req, res, end);

      // If "end" was not called, validate the response state, collect the
      // middleware's return handler (if any), and indicate that the next
      // middleware should be called.
      if (!endCalled) {
        if (res.error) {
          throw new EthereumRpcError(
            errorCodes.rpc.internal,
            errorMessages.noAssignmentToResponse,
            { request: req, responseError: res.error },
          );
        } else {
          if (returnHandler) {
            if (typeof returnHandler !== 'function') {
              throw new EthereumRpcError(
                errorCodes.rpc.internal,
                errorMessages.invalidReturnHandler(returnHandler),
                { request: req },
              );
            }
            returnHandlers.push(returnHandler);
          }

          resolve([null, false]);
        }
      }
    } catch (error) {
      JsonRpcEngine._processMiddlewareError(req, res, error);
      resolve([res.error, true]);
    }
    return middlewareCallbackPromise;
  }

  /**
   * Serially executes array of return handlers. The request and response are
   * assumed to be in their scope.
   */
  private static async _runReturnHandlers(
    handlers: JsonRpcEngineReturnHandler[],
  ): Promise<void> {
    for (const handler of handlers) {
      await handler();
    }
  }

  /**
   * Throws an error if the response has neither a result nor an error, or if
   * the "isComplete" flag is falsy.
   */
  private static _checkForCompletion(
    req: JsonRpcRequest<unknown>,
    res: PendingJsonRpcResponse<unknown>,
    isComplete: boolean,
  ): void {
    if (!('result' in res) && !('error' in res)) {
      throw new EthereumRpcError(
        errorCodes.rpc.internal,
        errorMessages.noErrorOrResult,
        { request: req },
      );
    }

    if (!isComplete) {
      throw new EthereumRpcError(
        errorCodes.rpc.internal,
        errorMessages.nothingEndedRequest,
        { request: req },
      );
    }
  }

  /**
   * Throws an appropriate error if the given response has its error property
   * set, or if the given argument to an "end" callback is truthy.
   *
   * Must only be called in the internal implementation of an "end" callback.
   */
  private static _validateEndState(
    req: JsonRpcRequest<unknown>,
    res: PendingJsonRpcResponse<unknown>,
    endArg: unknown,
  ) {
    if (endArg instanceof Error) {
      throw new EthereumRpcError(
        errorCodes.rpc.internal,
        errorMessages.noErrorsToEnd,
        { request: req, endCallbackCalledWith: endArg },
      );
    } else if (endArg) {
      throw new EthereumRpcError(
        errorCodes.rpc.internal,
        errorMessages.noValuesToEnd(endArg),
        { request: req, endCallbackCalledWith: endArg },
      );
    }

    if (res.error) {
      throw new EthereumRpcError(
        errorCodes.rpc.internal,
        errorMessages.noAssignmentToResponse,
        { request: req, responseError: res.error },
      );
    }
  }

  /**
   * Processes an error thrown during middleware processing, and coerces it into
   * a valid JSON-RPC error.
   *
   * Must only be called in response to an error thrown by a consumer middleware.
   */
  private static _processMiddlewareError(
    req: JsonRpcRequest<unknown>,
    res: PendingJsonRpcResponse<unknown>,
    error: unknown,
  ) {
    /* eslint-disable require-atomic-updates */
    if (error instanceof Error) {
      if (error instanceof EthereumRpcError) {
        res.error = error;
      } else {
        const { code } = error as any;
        res.error = new EthereumRpcError(
          isValidCode(code) ? code : errorCodes.rpc.internal,
          error.message,
          { request: req, originalError: error },
        );
      }
    } else {
      res.error = new EthereumRpcError(
        errorCodes.rpc.internal,
        errorMessages.threwNonError,
        { request: req, thrownValue: error },
      );
    }
    /* eslint-enable require-atomic-updates */
  }
}

function getDeferredPromise<T>(): [ Promise<T>, (value: T) => void] {
  let resolve: any;
  const promise: Promise<T> = new Promise((_resolve) => {
    resolve = _resolve;
  });
  return [promise, resolve];
}
