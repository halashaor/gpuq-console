import {pbkdf2, randomBytes, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';

const derive = promisify(pbkdf2);
const iterations = 600000;
const dummy = {salt: Buffer.alloc(16).toString('base64'), hash: Buffer.alloc(32).toString('base64'), iterations};

export class Pbkdf2Passwords {
  async hash(password) {
    const salt = randomBytes(16);
    const hash = await derive(password, salt, iterations, 32, 'sha256');
    return {salt: salt.toString('base64'), hash: hash.toString('base64'), iterations};
  }
  async verify(password, record) {
    const expected = record ?? dummy;
    const actual = await derive(password, Buffer.from(expected.salt, 'base64'), expected.iterations, 32, 'sha256');
    const matches = timingSafeEqual(actual, Buffer.from(expected.hash, 'base64'));
    return matches && record != null;
  }
}
