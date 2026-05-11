# Implementation Plan: AI Email Intelligence Assistant

## Overview

This implementation plan breaks down the AI Email Intelligence Assistant feature into discrete, testable coding tasks. The feature provides JARVIS-style intelligent email analysis using a local-first AI architecture with Ollama (llama3:3b) as the primary engine, ensuring zero cost, complete privacy, and offline capability.

**Key Architecture Decisions**:
- **Primary AI Engine**: Ollama running locally at http://localhost:11434
- **Model**: llama3:3b (3 billion parameter constraint for efficiency)
- **Hybrid Processing**: Rule-based preprocessing + local AI generation
- **Adaptive Intelligence**: Automatically adjust analysis depth based on complexity (SMALL/MEDIUM/LARGE)
- **Database**: PostgreSQL with 5 new columns in `outlook_emails_cache` table
- **Backend**: Node.js Express with new endpoint `POST /api/outlook/ai-assistant/analyze`
- **Frontend**: dashboard.html with modal UI for displaying results
- **Zero Cost**: No external API calls by default (optional fallback can be configured)

## Tasks

- [ ] 1. Database schema migration for AI assistant columns
  - Create migration file `backend/db/migrations/add_ai_assistant_columns.js`
  - Add 5 new columns to `outlook_emails_cache`: `ai_analyzed_at` (TIMESTAMPTZ), `ai_cleanup_recommended` (BOOLEAN), `ai_priority_score` (SMALLINT 0-100), `ai_detected_intent` (VARCHAR 50), `ai_detected_sentiment` (VARCHAR 30)
  - Create indexes on `ai_analyzed_at`, `received_datetime DESC`, and `ai_cleanup_recommended`
  - Run migration and verify schema changes
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.7, 8.8, 8.9, 8.10_

- [ ] 2. Implement Ollama service integration module
  - [ ] 2.1 Create Ollama service client at `backend/services/ollamaService.js`
    - Implement `callOllamaService(prompt, preprocessedEmails)` function
    - Configure Ollama host from environment variable `OLLAMA_HOST` (default: http://localhost:11434)
    - Configure model from `OLLAMA_MODEL` (default: llama3:3b)
    - Implement timeout handling (30 seconds from `OLLAMA_TIMEOUT`)
    - Use non-streaming mode for simplicity
    - Set temperature to 0.7 and limit output tokens to 1000 for 3B model
    - _Requirements: 6.1, 6.3, 6.8, 6.10_

  - [ ] 2.2 Implement system instructions for JARVIS-style behavior
    - Create `prepareSystemInstructions()` function with adaptive intelligence rules
    - Include SMALL/MEDIUM/LARGE complexity awareness (20%/40%/60% depth)
    - Enforce strict behavior rules (no questions, complete sentences, decision-driven output)
    - Define strict 4-section output format (Summary, Insights, Smart Actions, System Optimization)
    - Include efficiency awareness instructions for small models
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.9, 6.5, 6.6, 6.7, 9.6, 9.7_

  - [ ] 2.3 Implement user prompt builder with adaptive complexity
    - Create `buildUserPrompt(preprocessedEmails)` function
    - Calculate complexity level (SMALL/MEDIUM/LARGE) based on email count and urgency
    - Format email data as concise JSON structure (from, subject, preview, unreadHours, priority)
    - Include metadata (total count, unread count, urgent count)
    - Pass complexity hint to Ollama for adaptive analysis
    - _Requirements: 1.1, 1.2, 6.8, 9.1, 9.2, 9.8_

  - [ ]* 2.4 Write unit tests for Ollama service integration
    - Test API call formatting and request structure
    - Test response parsing and error handling
    - Test timeout behavior with mock delays
    - Test fallback to rule-based analysis on failure
    - _Requirements: 6.9, 6.10, 10.2, 10.3_

- [ ] 3. Implement rule-based preprocessing component
  - [ ] 3.1 Create email preprocessor at `backend/services/emailPreprocessor.js`
    - Implement `preprocessEmails(emails)` function
    - Calculate priority scores (0-100) using `calculatePriorityScore(email)` helper
    - Calculate unread duration in hours for unread emails
    - Sort emails by calculated priority (descending)
    - Filter top 10-20 emails for AI analysis (batch size optimization)
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 9.1, 9.2, 9.3, 9.8_

  - [ ] 3.2 Implement priority score calculation
    - Create `calculatePriorityScore(email)` function with multi-factor scoring
    - Factor in: importance flag (high/normal/low), read status, email age, has_attachments
    - Weight recent emails (last 48 hours) more heavily
    - Return score 0-100
    - _Requirements: 9.2, 9.3, 9.8, 9.9_

  - [ ] 3.3 Generate rule-based insights
    - Detect urgent unread emails (importance=high, is_read=false)
    - Count unread emails and high-importance unread
    - Generate basic insights with emoji indicators (🔴 for urgent)
    - Return insights array for hybrid combination with AI insights
    - _Requirements: 1.3, 1.6, 1.7, 2.4, 9.6_

  - [ ] 3.4 Generate cleanup recommendations
    - Identify emails older than 7 days
    - Calculate storage savings estimate (0.05 MB per email average)
    - Generate cleanup recommendation strings
    - Return recommendations for system optimization section
    - _Requirements: 4.1, 4.3, 4.6, 4.8, 4.9_

  - [ ]* 3.5 Write unit tests for preprocessing logic
    - Test priority score calculation with various email attributes
    - Test email sorting and top-N filtering
    - Test rule-based insight generation
    - Test cleanup recommendation logic
    - _Requirements: 9.9, 9.10_

- [ ] 4. Implement email analyzer orchestrator
  - [ ] 4.1 Create email analyzer at `backend/services/emailAnalyzer.js`
    - Implement `analyzeEmails(params)` main orchestration function
    - Validate parameters (timeframe, includeRead, maxEmails)
    - Query database for emails using `queryEmailsForAnalysis()`
    - Call preprocessor to get top emails and rule-based insights
    - Call Ollama service with preprocessed data
    - Combine rule-based and AI insights (hybrid approach)
    - Return structured analysis object
    - _Requirements: 1.1, 1.2, 1.10, 5.3, 5.4_

  - [ ] 4.2 Implement database query function
    - Create `queryEmailsForAnalysis(timeframe, includeRead, maxEmails)` function
    - Query `outlook_emails_cache` with timeframe filter (NOW() - INTERVAL 'X hours')
    - Apply read status filter if includeRead=false
    - Order by `received_datetime DESC`
    - Limit results to maxEmails parameter
    - Return email records array
    - _Requirements: 1.1, 1.2, 5.4, 8.8_

  - [ ] 4.3 Implement hybrid analysis function
    - Create `hybridEmailAnalysis(emails)` function
    - Step 1: Call preprocessor for rule-based analysis
    - Step 2: Call Ollama service with top 10-20 emails
    - Step 3: Combine rule-based insights with AI insights
    - Step 4: Merge cleanup recommendations
    - Return complete analysis with all sections
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 9.1, 9.3_

  - [ ] 4.4 Implement fallback to rule-based analysis
    - Catch Ollama service errors
    - Generate fallback response using only rule-based preprocessing
    - Include basic statistics (total, unread, urgent counts)
    - Set `fallback: true` and `fallbackReason` in response
    - Log fallback activation for monitoring
    - _Requirements: 10.2, 10.3, 10.7_

  - [ ]* 4.5 Write unit tests for email analyzer
    - Test parameter validation
    - Test database query construction
    - Test hybrid analysis workflow
    - Test fallback behavior on Ollama failure
    - _Requirements: 10.1, 10.2, 10.3_

- [ ] 5. Implement response formatter component
  - [ ] 5.1 Create response formatter at `backend/services/responseFormatter.js`
    - Implement `validateAndFormatResponse(aiResponse)` function
    - Parse AI response text into structured object
    - Extract 4 sections: Summary, Insights, Smart Actions, System Optimization
    - Validate format compliance (section headers, emoji indicators, numbering)
    - Ensure no questions in output (reject if found)
    - Ensure complete sentences (all end with . ! or ?)
    - _Requirements: 2.1, 2.2, 2.3, 2.10, 3.1, 3.2, 3.3, 3.8, 3.9, 3.10_

  - [ ] 5.2 Implement section extraction helpers
    - Create `extractSection(text, sectionName)` function
    - Handle variations in section header format
    - Extract content between section headers
    - Trim whitespace and normalize line breaks
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ] 5.3 Implement validation functions
    - Create `validateInsights(insights)` to check 3-6 insights with emoji indicators
    - Create `validateSmartActions(actions)` to check 3-4 numbered actions
    - Create `containsQuestions(text)` to detect question marks in inappropriate places
    - Create `hasIncompleteSentences(text)` to validate sentence endings
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.4, 3.5, 3.9_

  - [ ]* 5.4 Write unit tests for response formatter
    - Test section extraction with various formats
    - Test validation functions with valid and invalid inputs
    - Test question detection
    - Test sentence completion validation
    - _Requirements: 2.10, 3.10_

- [ ] 6. Implement cleanup manager component
  - [ ] 6.1 Create cleanup manager at `backend/services/cleanupManager.js`
    - Implement `generateCleanupRecommendations(emails, analysis)` function
    - Identify emails older than 7 days that have been analyzed
    - Exclude high-value leads (ai_detected_intent='opportunity', ai_priority_score>70)
    - Exclude emails requiring follow-up (ai_detected_intent='follow-up')
    - Calculate storage savings (email count * 0.05 MB)
    - Generate specific cleanup recommendation strings
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.9_

  - [ ] 6.2 Implement database flag update function
    - Create `updateEmailFlags(emailId, flags)` function
    - Update `ai_analyzed_at` to current timestamp
    - Update `ai_cleanup_recommended` boolean flag
    - Update `ai_priority_score` (0-100)
    - Update `ai_detected_intent` (inquiry/complaint/opportunity/follow-up/informational/promotional/system)
    - Update `ai_detected_sentiment` (positive/negative/neutral/dissatisfied/urgent)
    - _Requirements: 4.2, 4.10, 8.9, 8.10_

  - [ ]* 6.3 Write unit tests for cleanup manager
    - Test email age calculation
    - Test cleanup eligibility logic (exclude high-value, follow-ups)
    - Test storage savings calculation
    - Test flag update SQL generation
    - _Requirements: 4.1, 4.3, 4.5, 4.9_

- [ ] 7. Checkpoint - Ensure all backend components pass tests
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement API endpoint with authentication
  - [ ] 8.1 Add AI assistant route to `backend/routes/outlook.js`
    - Add `POST /api/outlook/ai-assistant/analyze` endpoint
    - Apply `authenticate` middleware for JWT validation
    - Apply rate limiter middleware (10 requests per minute per user)
    - Parse request parameters: timeframe (default 48), includeRead (default true), maxEmails (default 500)
    - Call email analyzer with parameters
    - Return JSON response with analysis results
    - _Requirements: 5.1, 5.2, 5.3, 5.6, 5.10_

  - [ ] 8.2 Implement rate limiting middleware
    - Use `express-rate-limit` package
    - Configure 10 requests per minute per user (key by user ID from JWT)
    - Return 429 status with error message on rate limit exceeded
    - Use per-user rate limiting (not global)
    - _Requirements: 5.10_

  - [ ] 8.3 Implement parameter validation
    - Validate timeframe is positive integer (1-168 hours)
    - Validate maxEmails is positive integer (1-500)
    - Validate includeRead is boolean
    - Return 400 status with specific error message for invalid parameters
    - _Requirements: 5.3, 10.6_

  - [ ] 8.4 Implement error handling
    - Catch database unavailable errors → return 503 with "Email cache temporarily unavailable"
    - Catch Ollama service errors → return 503 with "AI service temporarily unavailable. Please try again."
    - Catch timeout errors → return 504 with "Analysis request timed out. Try reducing the timeframe."
    - Catch all other errors → return 500 with generic error message
    - Log all errors server-side without exposing internal details
    - _Requirements: 5.7, 5.8, 10.1, 10.2, 10.3, 10.4, 10.7_

  - [ ] 8.5 Implement activity logging
    - Log all AI assistant requests to `system_activity_log` table
    - Include metadata: AI engine (ollama/rule-based/external-fallback), model name, response time, emails processed
    - Log successful analyses and errors
    - _Requirements: 5.9_

  - [ ] 8.6 Handle empty email cache scenario
    - Check if query returns zero emails
    - Return 200 status with friendly message: "No emails found in the specified timeframe."
    - Include suggestion to adjust timeframe or check email sync
    - _Requirements: 5.7, 10.5_

  - [ ]* 8.7 Write integration tests for API endpoint
    - Test authentication requirement (401 without JWT)
    - Test successful analysis with valid parameters
    - Test empty email cache handling
    - Test rate limiting enforcement
    - Test parameter validation errors
    - Test error responses for various failure scenarios
    - _Requirements: 5.1, 5.2, 5.3, 5.6, 5.7, 5.8, 5.10, 10.6_

- [ ] 9. Implement circuit breaker pattern for Ollama service
  - [ ] 9.1 Create circuit breaker class at `backend/services/ollamaCircuitBreaker.js`
    - Implement circuit breaker with 3 states: CLOSED, OPEN, HALF_OPEN
    - Set failure threshold to 3 consecutive failures
    - Set reset timeout to 60 seconds
    - Track failure count and last failure time
    - Implement `call(fn)` method to wrap Ollama service calls
    - _Requirements: 10.10_

  - [ ] 9.2 Integrate circuit breaker with Ollama service
    - Wrap `callOllamaService()` calls with circuit breaker
    - On OPEN state, immediately throw error to trigger fallback
    - On HALF_OPEN state, allow one test request
    - On success, reset circuit breaker to CLOSED
    - On failure, increment failure count and open circuit if threshold reached
    - Log circuit breaker state changes
    - _Requirements: 10.10_

  - [ ]* 9.3 Write unit tests for circuit breaker
    - Test state transitions (CLOSED → OPEN → HALF_OPEN → CLOSED)
    - Test failure threshold enforcement
    - Test reset timeout behavior
    - Test successful recovery
    - _Requirements: 10.10_

- [ ] 10. Checkpoint - Ensure backend API is fully functional
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Implement frontend UI integration in dashboard.html
  - [ ] 11.1 Add AI Email Assistant button to Outlook section toolbar
    - Add button with icon and label "AI Email Assistant" in Outlook section topbar
    - Style button with existing theme classes (btn-blue or btn-gold)
    - Add click handler to open AI assistant modal
    - Position button next to existing Outlook action buttons
    - _Requirements: 7.1_

  - [ ] 11.2 Create AI assistant modal structure
    - Add modal overlay div with ID `ai-assistant-modal`
    - Add modal content div with title "AI Email Assistant"
    - Add loading indicator (spinner) for analysis in progress
    - Add results display area with 4 sections
    - Add action buttons: "Refresh Analysis" and "Close"
    - Add timestamp display at bottom
    - Style modal with existing theme variables and classes
    - _Requirements: 7.2, 7.3, 7.7, 7.8, 7.10_

  - [ ] 11.3 Implement modal open/close functions
    - Create `openAIAssistant()` function to show modal and trigger analysis
    - Create `closeAIAssistant()` function to hide modal
    - Add event listeners for button clicks
    - Add ESC key handler to close modal
    - Add overlay click handler to close modal
    - _Requirements: 7.2, 7.8_

  - [ ] 11.4 Implement API call function
    - Create `fetchAIAnalysis()` async function
    - Make POST request to `/api/outlook/ai-assistant/analyze`
    - Include JWT token from localStorage in Authorization header
    - Send parameters: timeframe=48, includeRead=true, maxEmails=500
    - Handle response and error cases
    - Return parsed JSON data
    - _Requirements: 7.3, 7.4_

  - [ ] 11.5 Implement results display function
    - Create `displayAIResults(data)` function
    - Render Summary section as paragraph text (2-4 lines)
    - Render Insights section as bulleted list with emoji indicators (🔴, 🟡, 📈)
    - Render Smart Actions section as numbered list (1-4 items with action and reason)
    - Render System Optimization section as bulleted list
    - Display timestamp at bottom in readable format
    - Preserve formatting and line breaks
    - _Requirements: 7.4, 7.5, 7.6, 7.10_

  - [ ] 11.6 Implement error display function
    - Create `displayAIError(error)` function
    - Show user-friendly error message based on status code
    - 401: "Please log in again"
    - 503: "AI service temporarily unavailable. Please try again in a moment."
    - 504: "Analysis timed out. Try reducing the timeframe."
    - 429: "Too many requests. Please wait a minute."
    - Other: "An error occurred. Please try again."
    - Add "Retry" button for recoverable errors (503, 504, 500)
    - _Requirements: 7.9, 10.8, 10.9_

  - [ ] 11.7 Implement refresh analysis function
    - Create `refreshAIAnalysis()` function
    - Clear previous results
    - Show loading indicator
    - Call `fetchAIAnalysis()` again
    - Display new results or error
    - _Requirements: 7.7_

  - [ ] 11.8 Add Ollama status indicator (optional enhancement)
    - Add small status badge showing "Local AI" or "Ollama Active"
    - Show green indicator when Ollama is available
    - Show yellow indicator when using rule-based fallback
    - Update indicator based on response metadata
    - _Requirements: 7.10_

- [ ] 12. Implement environment configuration
  - [ ] 12.1 Add Ollama configuration to backend/.env
    - Add `OLLAMA_HOST=http://localhost:11434` (local Ollama server)
    - Add `OLLAMA_MODEL=llama3:3b` (3B parameter model)
    - Add `OLLAMA_TIMEOUT=30000` (30 seconds in milliseconds)
    - Add `AI_EXTERNAL_ENABLED=false` (disable external AI fallback by default)
    - Add `AI_EXTERNAL_PROVIDER=` (leave empty)
    - Add `AI_EXTERNAL_API_KEY=` (leave empty)
    - Add `AI_EXTERNAL_MODEL=` (leave empty)
    - Add `AI_ASSISTANT_ENABLED=true` (feature flag)
    - Add `AI_ASSISTANT_MAX_EMAILS=500` (max emails to query)
    - Add `AI_ASSISTANT_BATCH_SIZE=20` (emails per Ollama request)
    - Add `AI_ASSISTANT_RATE_LIMIT=10` (requests per minute per user)
    - _Requirements: 6.3_

  - [ ] 12.2 Update backend/.env.example
    - Add all Ollama configuration variables with comments
    - Document default values and purpose of each variable
    - Add setup instructions for Ollama
    - _Requirements: 6.3_

- [ ] 13. Create Ollama setup documentation
  - [ ] 13.1 Create OLLAMA_SETUP.md documentation file
    - Document Ollama installation steps for Windows/Mac/Linux
    - Document model download: `ollama pull llama3:3b`
    - Document how to verify Ollama is running: `curl http://localhost:11434/api/tags`
    - Document model selection recommendations (llama3:3b, phi3:mini, gemma:2b)
    - Document performance expectations (5-15 seconds for 20 emails)
    - Document resource requirements (2-4 GB RAM, moderate CPU)
    - Document troubleshooting common issues
    - _Requirements: 6.1, 6.3_

  - [ ] 13.2 Update main README.md with AI assistant feature
    - Add AI Email Intelligence Assistant to features list
    - Add link to OLLAMA_SETUP.md
    - Document zero-cost, privacy-first architecture
    - Document optional external AI fallback configuration
    - _Requirements: 6.1, 6.3_

- [ ] 14. Final checkpoint - End-to-end testing and validation
  - [ ] 14.1 Verify Ollama is installed and running
    - Check Ollama service is accessible at http://localhost:11434
    - Verify llama3:3b model is downloaded
    - Test Ollama API with sample request
    - _Requirements: 6.1_

  - [ ] 14.2 Run database migration
    - Execute migration script to add AI assistant columns
    - Verify all 5 columns are added to outlook_emails_cache
    - Verify indexes are created
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.7, 8.8_

  - [ ] 14.3 Test complete workflow manually
    - Log in to dashboard
    - Navigate to Outlook section
    - Click "AI Email Assistant" button
    - Verify modal opens with loading indicator
    - Wait for analysis to complete (should take 5-30 seconds)
    - Verify results display with all 4 sections
    - Verify emoji indicators render correctly
    - Verify timestamp is displayed
    - Test "Refresh Analysis" button
    - Test "Close" button
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.10_

  - [ ] 14.4 Test error scenarios
    - Stop Ollama service and verify fallback to rule-based analysis
    - Test with empty email cache (no emails in timeframe)
    - Test rate limiting by making 12 rapid requests
    - Test with invalid parameters
    - Verify all error messages are user-friendly
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9_

  - [ ] 14.5 Verify database updates
    - Check that analyzed emails have `ai_analyzed_at` timestamp
    - Check that `ai_priority_score` is set (0-100)
    - Check that `ai_detected_intent` and `ai_detected_sentiment` are populated
    - Check that `ai_cleanup_recommended` flag is set for old emails
    - Verify activity log entries are created
    - _Requirements: 4.2, 4.10, 5.9, 8.9, 8.10_

  - [ ] 14.6 Performance validation
    - Test with 50 emails - should complete in < 30 seconds
    - Test with 500 emails - preprocessing should be fast, AI analyzes top 20
    - Monitor Ollama response time
    - Monitor database query performance
    - Verify adaptive complexity works (SMALL/MEDIUM/LARGE)
    - _Requirements: 1.10, 6.8, 9.8_

  - [ ] 14.7 Security validation
    - Verify JWT authentication is enforced
    - Verify rate limiting works (10 requests/minute)
    - Verify email data is not exposed in error messages
    - Verify no sensitive data is logged
    - Verify Ollama requests stay local (no external network calls)
    - _Requirements: 5.1, 5.2, 5.10_

- [ ] 15. Ensure all tests pass and documentation is complete
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional testing tasks and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at key milestones
- The implementation uses **JavaScript/Node.js** with Express framework
- **Ollama (llama3:3b)** is the primary AI engine - zero cost, full privacy, offline capable
- **Hybrid processing** combines rule-based preprocessing with local AI generation
- **Adaptive intelligence** automatically adjusts analysis depth based on complexity
- Database migration must be run before using the feature
- Ollama must be installed and running locally before testing
- Optional external AI fallback (OpenAI/Claude) can be configured but is disabled by default
- Rate limiting prevents abuse while allowing reasonable usage (10 requests/minute)
- Circuit breaker pattern ensures resilience when Ollama service is unavailable
- All email data stays local - complete privacy and data sovereignty

## Implementation Order

1. **Phase 1: Database & Core Services** (Tasks 1-6) - Backend foundation
2. **Phase 2: API & Integration** (Tasks 7-10) - API endpoint and error handling
3. **Phase 3: Frontend UI** (Tasks 11) - User interface integration
4. **Phase 4: Configuration & Documentation** (Tasks 12-13) - Setup and docs
5. **Phase 5: Testing & Validation** (Tasks 14-15) - End-to-end verification

## Success Criteria

- ✅ Database migration completes successfully with all 5 new columns
- ✅ Ollama service integration works with llama3:3b model
- ✅ Rule-based preprocessing generates insights and cleanup recommendations
- ✅ Hybrid analysis combines rule-based and AI insights effectively
- ✅ API endpoint returns properly formatted 4-section response
- ✅ Frontend modal displays results with correct formatting and emoji indicators
- ✅ Error handling provides user-friendly messages and fallback to rule-based analysis
- ✅ Rate limiting prevents abuse (10 requests/minute per user)
- ✅ Circuit breaker protects against Ollama service failures
- ✅ Analysis completes in < 30 seconds for 50 emails
- ✅ All email data stays local - zero external API calls by default
- ✅ Activity logging tracks all AI assistant usage
- ✅ Documentation is complete and accurate
