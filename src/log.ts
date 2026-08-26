const t = () => new Date().toISOString().slice(11, 19);
export const log = {
  info: (tag: string, msg: string) => console.log(`${t()} [${tag}] ${msg}`),
  warn: (tag: string, msg: string) => console.warn(`${t()} [${tag}] ⚠ ${msg}`),
};
