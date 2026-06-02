import requests, base64

invoke_url = "https://integrate.api.nvidia.com/v1/chat/completions"
stream = False


headers = {
  "Authorization": "Bearer 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",
  "Accept": "text/event-stream" if stream else "application/json"
}

payload = {
  "model": "mistralai/mistral-large-3-675b-instruct-2512",
  "messages": [{"role":"user","content":""}],
  "max_tokens": 2048,
  "temperature": 0.15,
  "top_p": 1.00,
  "frequency_penalty": 0.00,
  "presence_penalty": 0.00,
  "stream": stream
}



response = requests.post(invoke_url, headers=headers, json=payload)

if stream:
    for line in response.iter_lines():
        if line:
            print(line.decode("utf-8"))
else:
    print(response.json())