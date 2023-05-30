import { searchIP } from 'range_check';
import { Request } from 'express-serve-static-core';

export function getRequestIp(req: Request) {
  let ip: string = req.ip;
  if (req.headers['x-original-forwarded-for']) {
    ip = req.headers['x-original-forwarded-for'] as string;
  } else if (req.headers['cf-connecting-ip']) {
    ip = req.headers['cf-connecting-ip'] as string;
  }
  return searchIP(ip)
}
