export function explainWhisperError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = error?.status ?? error?.response?.status;

  if (status === 401) {
    return {
      title: "Nieprawidłowy klucz API OpenAI",
      hint: "Sprawdź OPENAI_API_KEY w pliku .env.",
    };
  }

  if (status === 429) {
    return {
      title: "Limit zapytań OpenAI (rate limit)",
      hint: "Poczekaj chwilę i spróbuj ponownie.",
    };
  }

  if (status === 400) {
    return {
      title: "OpenAI odrzuciło żądanie (błąd 400)",
      hint: message,
    };
  }

  if (/premature close|err_stream_premature_close/i.test(message)) {
    return {
      title: "Połączenie z OpenAI zostało przerwane w trakcie transferu",
      hint: "Spróbuj ponownie lub użyj Node 20 LTS.",
    };
  }

  if (/timeout|timed out/i.test(message)) {
    return {
      title: "Przekroczono czas oczekiwania na odpowiedź Whisper",
      hint: "Nagranie trwało za długo. Spróbuj ponownie.",
    };
  }

  if (/econnreset|socket hang up|fetch failed|network/i.test(message)) {
    return {
      title: "Problem z połączeniem sieciowym do api.openai.com",
      hint: "Sprawdź internet i VPN.",
    };
  }

  return {
    title: "Błąd Whisper API",
    hint: message,
  };
}

export function formatWhisperFailure(error) {
  const { title, hint } = explainWhisperError(error);
  return `${title}. ${hint}`;
}
