import fetch from "node-fetch";

const OPENAI_KEY = process.env.OPENAI_API_KEY;

function generateRandomImg() {
  const randomId = Math.round(Math.random() * 100) + 1;
  return `https://picsum.photos/id/${randomId}/512/512`;
}

async function fetchRssItems() {
  const rssUrl = encodeURIComponent("https://lenta.ru/rss/news");
  const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${rssUrl}`;
  const rssRes = await fetch(apiUrl);
  if (!rssRes.ok) {
    throw new Error(`RSS: ${rssRes.status}`);
  }
  const rss = await rssRes.json();
  return Array.isArray(rss?.items) ? rss.items : [];
}

function buildPromptFromNews(items = []) {
  const newsBlock = items
    .slice(0, 6)
    .map((it) => `${it.title}\n${it.description || ""}`)
    .join("\n\n");

  return `На основе этих новостей:\n${newsBlock}\n\nСгенерируй массив из трёх новых постов в формате JSON. У каждого поста должны быть:\n- title\n- description (длинный, как полноценный новостной пост в Telegram)\nТолько массив из трёх постов, ничего лишнего, на русском языке.\nВажно: не используй обёртку \`\`\`json, никаких дополнительных комментариев или текста — только чистый JSON-массив.`;
}

export async function generatePosts() {
  if (!OPENAI_KEY) {
    throw new Error("OPENAI_API_KEY не задан");
  }

  const items = await fetchRssItems();
  const prompt = buildPromptFromNews(items);

  const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    }),
  });

  if (!aiRes.ok) {
    throw new Error(`OpenAI: ${aiRes.status}`);
  }

  const aiData = await aiRes.json();
  const text = aiData?.choices?.[0]?.message?.content;
  let posts = [];
  try {
    posts = JSON.parse(text);
  } catch {
    throw new Error("Не удалось распарсить JSON от OpenAI");
  }

  const withImages = posts.map((p) => ({ ...p, url: generateRandomImg() }));

  return withImages;
}
