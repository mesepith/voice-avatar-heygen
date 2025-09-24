const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";

export async function startHeygenSession() {
  const res = await fetch(`${API_BASE_URL}/api/heygen/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ avatar_id: "Marianne_CasualLook_public" }),
  });
  if (!res.ok) throw new Error(`API error: ${res.statusText}`);
  return res.json();
}

export async function stopHeygenSession(sessionId) {
  try {
    await fetch(`${API_BASE_URL}/api/heygen/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    });
  } catch (e) {
    console.error("Failed to notify backend of session stop:", e);
  }
}

export async function sendToLLM(text, sessionId) {
  if (!text || !sessionId) {
    console.error("sendToLLM requires text and sessionId");
    return;
  }
  try {
    const res = await fetch(`${API_BASE_URL}/api/talk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userText: text, session_id: sessionId }),
    });
    if (!res.ok) {
        const errorData = await res.json();
        throw new Error(`API error: ${res.status} - ${errorData.error || 'Unknown error'}`);
    }
    return await res.json();
  } catch (e) {
    console.error("sendToLLM fetch error:", e);
    // Return a default error shape so the frontend doesn't crash
    return { spoke: "I'm sorry, there was a connection issue.", ui: null, hindi_line: "" };
  }
}