import type { AdminRole } from '../generated/prisma/enums';
import type { Request } from 'express';
export type AuthUser={id:string;email:string;name:string;role:AdminRole;mustChangePassword:boolean;lastLoginAt:Date|null;sessionId:string};
export type AccessPayload={sub:string;email:string;role:AdminRole;sessionId:string};
export type RequestWithUser=Request&{user:AuthUser};
