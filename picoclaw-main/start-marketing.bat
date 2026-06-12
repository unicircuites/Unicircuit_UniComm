@echo off
echo ============================================
echo  Unicircuit Marketing & Sales — Picoclaw
echo  Model: Groq llama-3.3-70b (FREE)
echo  Agents: Sales Director, Lead Gen Specialist,
echo          Email Campaign Manager,
echo          WhatsApp Outreach Agent,
echo          Proposal Writer
echo ============================================
echo.
echo BEFORE STARTING:
echo  1. Edit config.marketing.json
echo  2. Replace gsk_YOUR_GROQ_API_KEY_HERE with your real key from console.groq.com
echo  3. Replace marketing-dashboard-token-change-me with a secure random string
echo  4. Make sure UNI_CRM backend is running (cd ../backend ^&^& node server.js)
echo.
echo Starting Marketing Picoclaw on port 18792...
echo.
cd /d "%~dp0"
picoclaw --config config.marketing.json
pause
