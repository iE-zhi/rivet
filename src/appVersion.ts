import packageMetadata from "../package.json";

/** 应用界面统一使用 package.json 中的版本号，禁止业务组件单独硬编码。 */
export const APP_VERSION = packageMetadata.version;
