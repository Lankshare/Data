// .github/scripts/update-link.js
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;

const issueUser = process.env.ISSUE_USER;
const issueBody = process.env.ISSUE_BODY;

const DATA_DIR = path.join(process.env.GITHUB_WORKSPACE, "data");

// Simple logger
function log(msg) {
  console.log(`[update-link] ${msg}`);
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

  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
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

// Parse a simple YAML file (flat key: "value" format) into an object
function parseYamlFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const data = {};
  for (const line of lines) {
    const match = line.match(/^\s*([\w-]+):\s*"?(.*?)"?\s*$/);
    if (match) {
      data[match[1]] = match[2];
    }
  }
  return data;
}

// Serialize an object back to YAML lines (flat key: "value" format)
function serializeYaml(data) {
  const lines = [];
  for (const [key, value] of Object.entries(data)) {
    lines.push(`${key}: "${value}"`);
  }
  return lines.join("\n") + "\n";
}

// Update a specific key in the YAML file (or add if missing)
function updateYamlKey(filePath, key, newValue) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  let found = false;
  const updatedLines = lines.map((line) => {
    const match = line.match(/^\s*([\w-]+):\s*"?(.*?)"?\s*$/);
    if (match && match[1] === key) {
      found = true;
      return `${key}: "${newValue}"`;
    }
    return line;
  });
  if (!found) {
    updatedLines.push(`${key}: "${newValue}"`);
  }
  fs.writeFileSync(filePath, updatedLines.join("\n"), "utf8");
}

async function main() {
  try {
    if (!issueUser || !issueBody) {
      throw new Error("Missing ISSUE_USER or ISSUE_BODY environment variables");
    }

    const fields = parseIssueBody(issueBody);
    log("Parsed fields:", JSON.stringify(fields, null, 2));

    if (!fields.link_id || !/^\d+$/.test(fields.link_id)) {
      throw new Error("Invalid or missing Link ID");
    }

    const filePath = path.join(DATA_DIR, `${fields.link_id}.yaml`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Link with ID ${fields.link_id} does not exist`);
    }

    // Check ownership
    const existingData = parseYamlFile(filePath);
    if (existingData.github !== issueUser) {
      throw new Error(`You are not the owner of link ID ${fields.link_id}`);
    }
    log("Ownership verified");

    // Determine if any optional field was provided
    const optionalFields = ["title", "name", "desc", "link", "avatar", "rss"];
    const hasAnyField = optionalFields.some((f) => fields[f] !== null);

    if (!hasAnyField) {
      // All optional fields are empty -> delete the file
      fs.unlinkSync(filePath);
      log(`Link ID ${fields.link_id} deleted`);
      setOutput("outcome", "success");
      setOutput(
        "message",
        `Successfully deleted link with ID ${fields.link_id}.`,
      );
      return;
    }

    // Validate and process URL/avatar/RSS if they are being updated
    if (fields.link) {
      if (!(await isSafeUrl(fields.link))) {
        throw new Error(
          `Link URL is not allowed or uses a private IP: ${fields.link}`,
        );
      }
      const linkOk = await checkUrl(fields.link);
      if (!linkOk) {
        throw new Error(`Link URL is not accessible: ${fields.link}`);
      }
    }

    let finalAvatar = null;
    if (fields.avatar) {
      finalAvatar = processAvatar(fields.avatar);
      if (!/^\d+$/.test(fields.avatar.trim())) {
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
    }

    if (fields.rss) {
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

    // Update the YAML file with provided fields
    const updates = {
      title: fields.title,
      name: fields.name,
      desc: fields.desc,
      link: fields.link,
      avatar: finalAvatar,
      rss: fields.rss,
    };

    for (const [key, value] of Object.entries(updates)) {
      if (value !== null) {
        updateYamlKey(filePath, key, value);
      }
    }

    log(`Link ID ${fields.link_id} updated`);
    setOutput("outcome", "success");
    setOutput(
      "message",
      `Successfully updated link with ID ${fields.link_id}.`,
    );
  } catch (err) {
    console.error(`[update-link] Error: ${err.message}`);
    setOutput("outcome", "failure");
    setOutput("message", `Failed: ${err.message}`);
  }
}

main();
