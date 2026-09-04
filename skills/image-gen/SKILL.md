---
name: image-gen
description: Generate an image and send it as an iMessage attachment.
---

# image-gen

## Flow

1. `generate_image(prompt, provider?, size?)` → returns an absolute file path.
2. `send_attachment(file_path, caption?)` → posts the image into the current chat.

Your final text reply is auto-sent. If you only want to send the image with no caption, do the attachment send and then reply with something short like "Here you go."

## Providers

- `openai` (default) — `gpt-image-1`, good at realistic and illustration.
- `gemini` — `imagen-3.0-generate-002`, strong on photographic detail.

Pick based on the user's vibe. If they say "photo" or "realistic," Gemini often shines. For illustrations, logos, diagrams, OpenAI is a safe default.

## Example

```
path = generate_image(prompt="a cozy cabin at dusk, warm window light, pine forest")
send_attachment(file_path=path, caption="cabin mood 🔥")
```
