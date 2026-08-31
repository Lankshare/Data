// .github/scripts/create-link.js
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;

const issueUser = process.env.ISSUE_USER;
const issueBody = process.env.ISSUE_BODY;

const TEMPLATE_PATH = path.join(process.env.GITHUB_WORKSPACE, "template.yaml");
const DATA_DIR = path.join(process.env.GITHUB_WORKSPACE, "data");

// Simple logger
function log(msg) {
  console.log(`[create-link] ${msg}`);
}

// Append a key=value line to the GitHub Actions output file
function setOutput(key, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

// Clean a field: trim whitespace and treat "_No response_" as null
function cleanField(value) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed === "_No response_" ? null : trimmed;
}

// Extract fields from the issue body using regex
function parseIssueBody(body) {
  const fields = {
    link_id: null,
    title: null,
    name: null,
    desc: null,
    link: null,
    avatar: null,
    rss: null,
  };

  const idRegex = /###\s*Link ID\s*\n+([^\n]+)/i;
  const titleRegex = /###\s*Site Title\s*\n+([^\n]+)/i;
  const nameRegex = /###\s*Nickname\s*\n+([^\n]+)/i;
  const descRegex = /###\s*Site Description\s*\n+([\s\S]*?)(?=###|$)/i;
  const linkRegex = /###\s*Site Link\s*\n+([^\n]+)/i;
  const avatarRegex = /###\s*Avatar\s*\n+([^\n]+)/i;
  const rssRegex = /###\s*RSS Feed URL\s*\n+([^\n]+)/i;

  const idMatch = body.match(idRegex);
  const titleMatch = body.match(titleRegex);
  const nameMatch = body.match(nameRegex);
  const descMatch = body.match(descRegex);
  const linkMatch = body.match(linkRegex);
  const avatarMatch = body.match(avatarRegex);
  const rssMatch = body.match(rssRegex);

  fields.link_id = cleanField(idMatch && idMatch[1]);
  fields.title = cleanField(titleMatch && titleMatch[1]);
  fields.name = cleanField(nameMatch && nameMatch[1]);
  fields.desc = cleanField(descMatch && descMatch[1]);
  fields.link = cleanField(linkMatch && linkMatch[1]);
  fields.avatar = cleanField(avatarMatch && avatarMatch[1]);
  fields.rss = cleanField(rssMatch && rssMatch[1]);

  return fields;
}

// Check if an IPv4 address is private or reserved
function isPrivateIpv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return true;
  const [a, b, c, d] = parts;

  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224 && a <= 239) return true;
  if (a >= 240) return true;

  return false;
}

// Check if an IPv6 address is private or reserved
function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase().split("%")[0];

  if (normalized === "::") return true;
  if (normalized === "::1") return true;

  if (normalized.startsWith("::ffff:")) {
    const ipv4Part = normalized.substring("::ffff:".length);
    return isPrivateIpv4(ipv4Part);
  }

  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }

  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }

  return false;
}

// Combined IP check: dispatch to IPv4 or IPv6
function isPrivateIp(ip) {
  if (ip.includes(":")) {
    return isPrivateIpv6(ip);
  }
  return isPrivateIpv4(ip);
}

// Validate that a URL uses only http/https and resolves to public IPs
async function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const hostname = parsed.hostname;
    const addresses = await dns.lookup(hostname, { all: true });
    for (const addr of addresses) {
      if (isPrivateIp(addr.address)) {
        log(`Blocked private IP: ${addr.address}`);
        return false;
      }
    }
    return true;
  } catch (err) {
    log(`URL validation failed: ${err.message}`);
    return false;
  }
}

// Check URL accessibility with timeout and HEAD fallback to GET
async function checkUrl(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    let response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      });
    }
    return response.ok;
  } catch (err) {
    log(`URL check failed for ${url}: ${err.message}`);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Convert avatar input to a final URL
function processAvatar(avatarInput) {
  const trimmed = avatarInput.trim();
  if (/^\d+$/.test(trimmed)) {
    return `http://q.qlogo.cn/g?b=qq&nk=${trimmed}&s=640`;
  }
  return trimmed;
}

// Validate custom ID format: only lowercase letters, numbers, and hyphens
function isValidId(id) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(id);
}

async function main() {
  try {
    if (!issueUser || !issueBody) {
      throw new Error("Missing ISSUE_USER or ISSUE_BODY environment variables");
    }

    const fields = parseIssueBody(issueBody);
    log("Parsed fields:", JSON.stringify(fields, null, 2));

    if (!fields.name || !fields.link) {
      throw new Error("Required fields missing: name, link");
    }

    if (!(await isSafeUrl(fields.link))) {
      throw new Error(
        `Link URL is not allowed or uses a private IP: ${fields.link}`,
      );
    }

    const finalAvatar = processAvatar(fields.avatar);
    log("Final avatar:", finalAvatar);

    const linkOk = await checkUrl(fields.link);
    if (!linkOk) {
      throw new Error(`Link is not accessible: ${fields.link}`);
    }

    if (fields.avatar && !/^\d+$/.test(fields.avatar.trim())) {
      log("Checking custom avatar URL...");
      if (!(await isSafeUrl(finalAvatar))) {
        throw new Error(
          `Avatar URL is not allowed or uses a private IP: ${finalAvatar}`,
        );
      }
      const avatarOk = await checkUrl(finalAvatar);
      if (!avatarOk) {
        throw new Error(`Avatar URL is not accessible: ${finalAvatar}`);
      }
    }

    if (fields.rss) {
      log("Checking RSS URL...");
      if (!(await isSafeUrl(fields.rss))) {
        throw new Error(
          `RSS URL is not allowed or uses a private IP: ${fields.rss}`,
        );
      }
      const rssOk = await checkUrl(fields.rss);
      if (!rssOk) {
        throw new Error(`RSS URL is not accessible: ${fields.rss}`);
      }
    }

    if (!fs.existsSync(TEMPLATE_PATH)) {
      throw new Error(`Template file not found: ${TEMPLATE_PATH}`);
    }
    let templateContent = fs.readFileSync(TEMPLATE_PATH, "utf8");
    log("Template loaded");

    const replacements = {
      "#[TITLE]#": fields.title || fields.name,
      "#[NAME]#": fields.name,
      "#[DESCRIPTION]#": fields.desc,
      "#[LINK]#": fields.link,
      "#[AVATAR]#": finalAvatar,
      "#[GITHUB]#": issueUser,
      "#[RSS]#": fields.rss || "",
    };

    if (!fields.rss) {
      templateContent = templateContent.replace(
        /^\s*rss:\s*"#\[RSS\]#"\s*\n?/gm,
        "",
      );
    }

    for (const [placeholder, value] of Object.entries(replacements)) {
      templateContent = templateContent.split(placeholder).join(value);
    }

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!fields.link_id) {
      throw new Error("Required field missing: link_id");
    }

    if (!isValidId(fields.link_id)) {
      throw new Error(
        `Invalid Link ID: "${fields.link_id}". Only lowercase letters, numbers, and hyphens are allowed.`
      );
    }

    const newFilePath = path.join(DATA_DIR, `${fields.link_id}.yaml`);

    if (fs.existsSync(newFilePath)) {
      throw new Error(`Link ID "${fields.link_id}" already exists. Please choose a different one.`);
    }

    log(`New file: ${newFilePath}`);

    fs.writeFileSync(newFilePath, templateContent, "utf8");
    log("File written successfully");

    setOutput("outcome", "success");
    setOutput("message", `Successfully added link with ID ${fields.link_id}.`);
    setOutput("id", fields.link_id);
  } catch (err) {
    console.error(`[create-link] Error: ${err.message}`);
    setOutput("outcome", "failure");
    setOutput("message", `Failed: ${err.message}`);
  }
}

main();
