// 记录存储层：只负责 JSON 文件的读写、原子落盘与写操作串行化。
// 领域判定不在这一层，server 的每次写请求都经过 mutate 排队，
// 保证“校验 + 写入”对并发提交是原子的，重载后状态以文件为准。
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export class JsonStore {
  constructor(file, seed) {
    this.file = file;
    this.seed = seed;
    this.tail = Promise.resolve();
  }

  async read() {
    if (!existsSync(this.file)) {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.seed, null, 2));
      return JSON.parse(JSON.stringify(this.seed));
    }
    return JSON.parse(await readFile(this.file, "utf8"));
  }

  async #persist(db) {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, this.file);
  }

  // worker 抛错则不写盘；同一时刻只有一个 worker 执行。
  mutate(worker) {
    const run = this.tail.then(async () => {
      const db = await this.read();
      const result = await worker(db);
      await this.#persist(db);
      return result;
    });
    this.tail = run.then(
      () => {},
      () => {}
    );
    return run;
  }
}
