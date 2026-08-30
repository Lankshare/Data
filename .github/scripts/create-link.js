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

// Extract fields from the issue body using regex
function parseIssueBody(body) {
  const fields = {
    title: null,
    name: null,
    desc: null,
    link: null,
    avatar: null,
  };

  const titleRegex = /###\s*Site Title\s*\n+([^\n]+)/i;
  const nameRegex = /###\s*Nickname\s*\n+([^\n]+)/i;
  const descRegex = /###\s*Site Description\s*\n+([\s\S]*?)(?=###|$)/i;
  const linkRegex = /###\s*Site Link\s*\n+([^\n]+)/i;
  const avatarRegex = /###\s*Avatar\s*\n+([^\n]+)/i;

  const titleMatch = body.match(titleRegex);
  const nameMatch = body.match(nameRegex);
  const descMatch = body.match(descRegex);
  const linkMatch = body.match(linkRegex);
  const avatarMatch = body.match(avatarRegex);

  if (titleMatch) fields.title = titleMatch[1].trim();
  if (nameMatch) fields.name = nameMatch[1].trim();
  if (descMatch) fields.desc = descMatch[1].trim();
  if (linkMatch) fields.link = linkMatch[1].trim();
  if (avatarMatch) fields.avatar = avatarMatch[1].trim();

  return fields;
}

// Check whether an IP address is private, reserved, or otherwise unsafe
function isPrivateIp(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return true; // treat non-IPv4 as unsafe
  const [a, b, c, d] = parts;

  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 100.64.0.0/10 (carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24, 192.0.2.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (multicast)
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 (reserved)
  if (a >= 240) return true;

  return false;
}

// Validate that a URL uses only http/https and resolves to public IPs
async function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const hostname = parsed.hostname;
    // Resolve all IP addresses for the hostname
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
    // Try HEAD first (lighter)
    let response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      // If HEAD fails, try GET
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
  if (/^\d+$/.test(avatarInput.trim())) {
    return `http://q.qlogo.cn/g?b=qq&nk=${avatarInput.trim()}`;
  }
  return avatarInput.trim();
}

// Determine the next available numeric ID for a new YAML file
function getNextId(dataDir) {
  const files = fs.readdirSync(dataDir).filter((f) => /^\d+\.yaml$/.test(f));
  if (files.length === 0) {
    return 100000001;
  }
  const maxNum = files.reduce((max, file) => {
    const num = parseInt(file.replace(".yaml", ""), 10);
    return num > max ? num : max;
  }, 0);
  return maxNum + 1;
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

    // Validate that the link is safe before attempting any fetch
    if (!(await isSafeUrl(fields.link))) {
      throw new Error(
        `Link URL is not allowed or uses a private IP: ${fields.link}`,
      );
    }

    const finalAvatar = processAvatar(fields.avatar);
    log("Final avatar:", finalAvatar);

    // Check link accessibility
    const linkOk = await checkUrl(fields.link);
    if (!linkOk) {
      throw new Error(`Link is not accessible: ${fields.link}`);
    }

    // If a custom avatar URL is provided (not a QQ number), check it too
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

    // Load and fill the template
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
    };

    for (const [placeholder, value] of Object.entries(replacements)) {
      templateContent = templateContent.split(placeholder).join(value);
    }

    // Create data directory if needed
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Write the new YAML file
    const nextId = getNextId(DATA_DIR);
    const newFilePath = path.join(DATA_DIR, `${nextId}.yaml`);
    log(`New file: ${newFilePath}`);

    fs.writeFileSync(newFilePath, templateContent, "utf8");
    log("File written successfully");

    setOutput("outcome", "success");
    setOutput("message", `Successfully added link with ID ${nextId}.`);
  } catch (err) {
    console.error(`[create-link] Error: ${err.message}`);
    setOutput("outcome", "failure");
    setOutput("message", `Failed: ${err.message}`);
  }
}

main();
