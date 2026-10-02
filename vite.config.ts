// CI 里用 VITE_BASE_URL 指向 CDN 路径;本地默认相对路径,方便放在任意子目录下
export default {
  base: process.env.VITE_BASE_URL ?? "./",
  build: { target: "es2022" },
};
