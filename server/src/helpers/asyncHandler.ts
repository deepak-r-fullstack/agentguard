import { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 does not catch rejected promises. Wrap every async controller so
// errors reach the error middleware instead of crashing or hanging the request.
export function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
