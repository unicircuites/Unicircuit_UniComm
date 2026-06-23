$k = "YOUR_GROQ_API_KEY_HERE"
$p = "C:\setup0\Unicircuit_UniComm"

# Update picoclaw config files
(Get-Content "$p\picoclaw-main\config.marketing.json") -replace "YOUR_GROQ_API_KEY_HERE", $k | Set-Content "$p\picoclaw-main\config.marketing.json"
(Get-Content "$p\picoclaw-main\config.seo.json") -replace "YOUR_GROQ_API_KEY_HERE", $k | Set-Content "$p\picoclaw-main\config.seo.json"

# Update or add AI_API_KEY in .env
$envPath = "$p\backend\.env"
$envContent = Get-Content $envPath
if ($envContent -match "AI_API_KEY=") {
    $envContent -replace "AI_API_KEY=.*", "AI_API_KEY=$k" | Set-Content $envPath
} else {
    Add-Content $envPath "AI_API_KEY=$k"
}

# Restart backend with updated env vars
pm2 restart unicomm-backend --update-env

Write-Host "Done! Groq API key updated in all files and backend restarted." -ForegroundColor Green
