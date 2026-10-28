import { Request, Response } from "express";
import { z } from "zod";
import { successResponseWithData } from "../helpers/response";
import { login } from "../services/auth/auth.service";
import { getRequestUser } from "../middlewares/auth.middleware";

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export async function loginUser(_req: Request, res: Response) {
  const { email, password } = res.locals.body as z.infer<typeof loginSchema>;
  const session = await login(email, password);
  return successResponseWithData(res, "Signed in.", session);
}

export async function getCurrentUser(_req: Request, res: Response) {
  const user = getRequestUser(res);
  return successResponseWithData(res, "Current user.", {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    workspaceId: String(user.workspaceId),
  });
}
