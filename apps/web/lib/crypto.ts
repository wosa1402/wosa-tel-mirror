import { loadEnv } from "@/lib/env";

loadEnv();

export { decrypt, encrypt } from "@tg-back/crypto";

