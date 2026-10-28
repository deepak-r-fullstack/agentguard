import { Response } from "express";

// One response shape for every endpoint: { success, message, data? }.
// Same contract as helpers/response.js in the NueAssist services.

export function successResponse(res: Response, message: string) {
  return res.status(200).json({ success: true, message });
}

export function successResponseWithData<T>(res: Response, message: string, data: T, statusCode = 200) {
  return res.status(statusCode).json({ success: true, message, data });
}

export function errorResponse(res: Response, statusCode: number, message: string, details?: unknown) {
  return res.status(statusCode).json({
    success: false,
    message,
    ...(details ? { details } : {}),
  });
}
