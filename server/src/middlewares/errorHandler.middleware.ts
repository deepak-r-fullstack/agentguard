import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { AppError } from "../helpers/errors";
import { errorResponse } from "../helpers/response";
import { logger, serializeError } from "../utils/logger";

export function notFoundHandler(_req: Request, res: Response) {
  return errorResponse(res, 404, "This address does not exist.");
}

// Must be registered after every route. Logs the route template, never the
// full URL or body (they can contain personal data).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return errorResponse(res, err.statusCode, err.message, err.details);
  }
  if (err instanceof mongoose.Error.CastError) {
    return errorResponse(res, 404, "We could not find that item.");
  }
  if (err instanceof SyntaxError && "body" in (err as object)) {
    return errorResponse(res, 400, "The request body is not valid JSON.");
  }

  logger.error("unhandled request error", {
    method: req.method,
    route: req.route?.path ? `${req.baseUrl}${req.route.path}` : req.baseUrl,
    ...serializeError(err),
  });
  return errorResponse(res, 500, "Something went wrong on our side. Please try again.");
}
