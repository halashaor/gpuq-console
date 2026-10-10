import {InvalidRequest} from '../contracts/errors.mjs';
import {ApplicationError} from '../domain/errors.mjs';

export function reply(res, status, body, headers = {}) {
  res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers});
  res.end(JSON.stringify(body));
}

export async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const part of req.iterator({destroyOnReturn: false})) {
    size += part.length;
    if (size > 8192) {
      req.resume();
      throw new InvalidRequest('body');
    }
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new InvalidRequest('body'); }
}

export function replyError(res, error, statusByCode, reportError) {
  if (error instanceof InvalidRequest) {
    return reply(res, 400, {error: {code: 'INVALID_REQUEST', field: error.field}});
  }
  const status = error instanceof ApplicationError ? statusByCode[error.code] : undefined;
  if (!status || status >= 500) reportError(error);
  reply(res, status || 500, {error: {code: status ? error.code : 'INTERNAL_ERROR'}});
}
