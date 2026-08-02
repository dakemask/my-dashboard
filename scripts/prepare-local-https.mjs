import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const certPath = process.env.DASHBOARD_DEV_CERT
  ?? resolve(projectRoot, ".cert", "my-dashboard.pem");
const keyPath = process.env.DASHBOARD_DEV_KEY
  ?? resolve(projectRoot, ".cert", "my-dashboard-key.pem");
const phoneRootCertificatePath = process.env.DASHBOARD_DEV_ROOT_CA
  ?? resolve(projectRoot, "certificates", "rootCA.pem");
const metadataPath = `${certPath}.hosts.json`;

const hosts = [
  "localhost",
  "127.0.0.1",
  "::1",
  ...findLanIPv4Addresses(),
];

ensureMkcertAvailable();
runMkcertInstall();
copyRootCertificateForDevice();

if (needsCertificateRefresh(hosts)) {
  generateCertificate(hosts);
}

function findLanIPv4Addresses() {
  const addresses = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const network of interfaces ?? []) {
      const family = network.family;
      if (
        network.internal
        || (family !== "IPv4" && family !== 4)
        || !isPrivateIPv4(network.address)
      ) {
        continue;
      }
      addresses.push(network.address);
    }
  }
  return [...new Set(addresses)].sort();
}

function isPrivateIPv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return false;
  }
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function ensureMkcertAvailable() {
  try {
    execFileSync("mkcert", ["-version"], { stdio: "ignore" });
  } catch {
    const installCommand = process.platform === "win32"
      ? "winget install FiloSottile.mkcert"
      : process.platform === "darwin"
        ? "brew install mkcert"
        : "请参阅 https://github.com/FiloSottile/mkcert#installation 安装 mkcert";
    throw new Error(`找不到 mkcert。请先安装一次：${installCommand}`);
  }
}

function runMkcertInstall() {
  execFileSync("mkcert", ["-install"], { stdio: "inherit" });
}

function copyRootCertificateForDevice() {
  const caRoot = execFileSync("mkcert", ["-CAROOT"], { encoding: "utf8" }).trim();
  const sourcePath = resolve(caRoot, "rootCA.pem");
  if (!existsSync(sourcePath)) {
    throw new Error(`mkcert 根证书未找到：${sourcePath}`);
  }

  mkdirSync(dirname(phoneRootCertificatePath), { recursive: true });
  if (resolve(sourcePath) !== resolve(phoneRootCertificatePath)) {
    copyFileSync(sourcePath, phoneRootCertificatePath);
  }
  console.log(`手机端根证书已输出到：${phoneRootCertificatePath}`);
}

function needsCertificateRefresh(expectedHosts) {
  if (!existsSync(certPath) || !existsSync(keyPath) || !existsSync(metadataPath)) {
    return true;
  }
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    return JSON.stringify(metadata.hosts) !== JSON.stringify(expectedHosts);
  } catch {
    return true;
  }
}

function generateCertificate(expectedHosts) {
  if (expectedHosts.length === 3) {
    throw new Error("未检测到局域网 IPv4 地址，请先连接 Wi-Fi 或有线局域网后重试。");
  }

  const certDirectory = dirname(certPath);
  mkdirSync(certDirectory, { recursive: true });
  const temporaryDirectory = join(certDirectory, ".tmp");
  const temporaryCertPath = join(temporaryDirectory, "my-dashboard.pem");
  const temporaryKeyPath = join(temporaryDirectory, "my-dashboard-key.pem");
  rmSync(temporaryDirectory, { recursive: true, force: true });
  mkdirSync(temporaryDirectory, { recursive: true });

  try {
    execFileSync(
      "mkcert",
      ["-key-file", temporaryKeyPath, "-cert-file", temporaryCertPath, ...expectedHosts],
      { stdio: "inherit" },
    );
    rmSync(certPath, { force: true });
    rmSync(keyPath, { force: true });
    renameSync(temporaryCertPath, certPath);
    renameSync(temporaryKeyPath, keyPath);
    writeFileSync(metadataPath, JSON.stringify({ hosts: expectedHosts }, null, 2));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
