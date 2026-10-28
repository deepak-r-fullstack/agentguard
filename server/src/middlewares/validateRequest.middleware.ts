import { NextFunction, Request, Response } from "express";
import { ZodTypeAny } from "zod";
import { BadRequestError } from "../helpers/errors";

type RequestPart = "body" | "query" | "params";

// Validates one part of the request with zod and replaces it with the parsed
// (trimmed, defaulted, type-coerced) value, so controllers only see clean data.
export function validateRequest(schema: ZodTypeAny, part: RequestPart = "body") {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      return next(new BadRequestError("Some details are missing or not valid.", result.error.flatten()));
    }
    // req.query is a getter in Express; keep the parsed copy on res.locals for every part.
    res.locals[part] = result.data;
    return next();
  };
}
