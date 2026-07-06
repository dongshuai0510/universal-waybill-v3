/** 本地/部署后填充演示数据的 CLI：npm run seed */
import { runSeedCli } from "../src/lib/seed";

runSeedCli()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
