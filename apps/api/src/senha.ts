import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt (nativo do Node) no lugar de Argon2: mesma classe de segurança, sem dependência nativa.
function derivar(senha: string, sal: Buffer): Promise<Buffer> {
  return new Promise((ok, erro) =>
    scrypt(senha, sal, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? erro(e) : ok(k))),
  );
}

export async function hashSenha(senha: string): Promise<string> {
  const sal = randomBytes(16);
  const k = await derivar(senha, sal);
  return `scrypt$${sal.toString('hex')}$${k.toString('hex')}`;
}

export async function conferirSenha(senha: string, hash: string): Promise<boolean> {
  const [alg, salHex, kHex] = hash.split('$');
  if (alg !== 'scrypt' || !salHex || !kHex) return false;
  const esperado = Buffer.from(kHex, 'hex');
  const k = await derivar(senha, Buffer.from(salHex, 'hex'));
  return k.length === esperado.length && timingSafeEqual(k, esperado);
}
