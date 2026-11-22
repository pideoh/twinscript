# Getting a Gemini API key

Twinscript talks to Google's Gemini API with your own key. Getting one takes a few minutes and a Google account.

1. Open [Google AI Studio](https://aistudio.google.com/apikey) and sign in with your Google account.
2. Create an API key. If AI Studio asks which Google Cloud project the key belongs to, let it create a new one.
3. Copy the key.
4. In Twinscript, open the settings (gear button, top right), paste the key into "Gemini API key" and save.
5. Choose the two languages and press "Start translating".

The key is stored on your computer only, encrypted by the operating system. See [Privacy](../README.md#privacy).

## Free or paid

A new key works on the free tier, which has rate limits. On the free tier Google may use what you send to improve
its products, so use a paid key for confidential meetings. To make a key paid, link its project to a Google Cloud
billing account in AI Studio. Prices are in [Pricing](../README.md#pricing).

## If it does not work

| What you see | What to do |
| --- | --- |
| The app asks for the key when you press start | No key is saved yet. Enter it in the settings. |
| A message that the connection failed, mentioning the API key or permission | The key was mistyped or deleted. Copy it again from AI Studio. |
| A message about the rate limit | The free tier's limit was reached. Translation of unfinished sentences pauses for a minute; finished sentences keep being translated. |
