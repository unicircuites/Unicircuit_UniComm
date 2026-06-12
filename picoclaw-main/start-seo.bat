@echo off
echo ============================================
echo  Unicircuit SEO Optimization — Picoclaw
echo  Model: Groq llama-3.3-70b (FREE)
echo  Agents: SEO Director, Keyword Analyst,
echo          Content Strategist, Tech Auditor,
echo          Local SEO Specialist
echo ============================================
echo.
echo BEFORE STARTING:
echo  1. Edit config.seo.json
echo  2. Replace gsk_YOUR_GROQ_API_KEY_HERE with your real key from console.groq.com
echo  3. Replace seo-dashboard-token-change-me with a secure random string
echo.
echo Starting SEO Picoclaw on port 18791...
echo.
cd /d "%~dp0"
picoclaw --config config.seo.json
pause
