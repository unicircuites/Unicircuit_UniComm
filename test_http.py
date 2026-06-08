from openai import OpenAI

client = OpenAI(
  base_url = "https://integrate.api.nvidia.com/v1",
  api_key = "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"
)


prompt = input("Ask: ")

# 🔥 Claude-style routing
if len(prompt) < 100:
    model = "mistralai/mistral-7b-instruct"   # ⚡ Haiku
else:
    model = "mistralai/mixtral-8x7b-instruct-v0.1"  # 🧠 Sonnet/Opus

completion = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": prompt}]
)

print("\nModel used:", model)
print("\nAnswer:\n")
print(completion.choices[0].message.content)
