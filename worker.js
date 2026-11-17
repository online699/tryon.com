// Cloudflare Worker: وسيط بين متجر Shopify وخدمة التجربة الافتراضية (fal.ai)
// المتغيرات (Settings > Variables and Secrets):
//   FAL_KEY          (Secret)  مفتاح fal.ai
//   ALLOWED_ORIGINS  مثال: https://your-store.myshopify.com,https://www.yourbrand.com
//   GARMENT_HOSTS    اختياري، الافتراضي: cdn.shopify.com
//   ALLOW_DATA_GARMENT  اكتب true أثناء الاختبار المستقل فقط (يسمح برفع صورة القطعة)
//   PER_IP_HOUR / DAILY_CAP  اختياري (يحتاجا KV باسم RL)

const FAL_URL = "https://fal.run/fal-ai/image-apps-v2/virtual-try-on";
const MAX_PERSON_CHARS = 4_000_000;

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": okOrigin ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return reply({ error: "method" }, 405);
    if (!okOrigin) return reply({ error: "origin" }, 403);

    let body;
    try { body = await req.json(); } catch { return reply({ error: "json" }, 400); }

    // 1) صورة الشخص: data URL صورة وبحجم معقول
    const person = body.person;
    if (typeof person !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(person) || person.length > MAX_PERSON_CHARS)
      return reply({ error: "person" }, 400);

    // 2) صورة القطعة: رابط من دومين مسموح، أو (في وضع الاختبار فقط) صورة مرفوعة
    let garmentUrl;
    const g = String(body.garment || "");
    if (/^data:image\/(jpeg|png|webp);base64,/.test(g)) {
      if (env.ALLOW_DATA_GARMENT !== "true" || g.length > MAX_PERSON_CHARS) return reply({ error: "garment" }, 400);
      garmentUrl = g;
    } else {
      let garment = g;
      if (garment.startsWith("//")) garment = "https:" + garment;
      let gu;
      try { gu = new URL(garment); } catch { return reply({ error: "garment" }, 400); }
      const hosts = (env.GARMENT_HOSTS || "cdn.shopify.com").split(",").map(s => s.trim());
      if (gu.protocol !== "https:" || !hosts.includes(gu.hostname)) return reply({ error: "garment_host" }, 400);
      garmentUrl = gu.href;
    }

    // 3) حدود الاستخدام (اختياري، لو ربطت KV باسم RL) لحماية الرصيد
    if (env.RL) {
      const ip = req.headers.get("CF-Connecting-IP") || "x";
      const hour = Math.floor(Date.now() / 3600000);
      const day = new Date().toISOString().slice(0, 10);
      const ik = `ip:${ip}:${hour}`, dk = `day:${day}`;
      const n = parseInt((await env.RL.get(ik)) || "0", 10);
      const d = parseInt((await env.RL.get(dk)) || "0", 10);
      if (n >= parseInt(env.PER_IP_HOUR || "5", 10)) return reply({ error: "rate" }, 429);
      if (d >= parseInt(env.DAILY_CAP || "100", 10)) return reply({ error: "cap" }, 429);
      await env.RL.put(ik, String(n + 1), { expirationTtl: 3700 });
      await env.RL.put(dk, String(d + 1), { expirationTtl: 90000 });
    }

    // 4) نداء الخدمة
    try {
      const res = await fetch(FAL_URL, {
        method: "POST",
        headers: { Authorization: `Key ${env.FAL_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ person_image_url: person, clothing_image_url: garmentUrl, preserve_pose: true }),
      });
      if (!res.ok) { console.log("fal status", res.status, (await res.text()).slice(0, 300)); return reply({ error: "upstream" }, 502); }
      const data = await res.json();
      const url = data?.images?.[0]?.url;
      if (typeof url !== "string" || !url.startsWith("https://")) return reply({ error: "no_image" }, 502);
      return reply({ image: url });
    } catch (e) {
      console.log("fetch error", String(e));
      return reply({ error: "upstream" }, 502);
    }
  },
};
