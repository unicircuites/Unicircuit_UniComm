# Requirements Document

## Introduction

The AI Email Intelligence Assistant is a JARVIS-style intelligent email analysis system that provides human-like decision-making and actionable insights from stored email data. The system analyzes emails from the `outlook_emails_cache` database table, detects urgency, sentiment, and intent, and provides smart recommendations while maintaining system hygiene through automated cleanup suggestions.

The assistant operates with a confident, direct, and intelligent tone, always producing complete, decision-driven responses without asking questions. It prioritizes recent emails (last 48 hours) and focuses on detecting urgency, unread duration, customer dissatisfaction, missed replies, high-value leads, and system inefficiencies.

## Glossary

- **AI_Assistant**: The intelligent email analysis system that processes email data and generates insights
- **Email_Cache**: The PostgreSQL `outlook_emails_cache` table containing temporarily stored email data
- **Analysis_Engine**: The component that performs urgency, sentiment, and intent detection on emails
- **Response_Formatter**: The component that formats analysis results into the strict output format
- **Cleanup_Manager**: The component that identifies and marks emails for deletion after analysis
- **Dashboard_UI**: The existing `dashboard.html` interface where the assistant is accessible
- **Backend_API**: The Node.js Express server that handles AI assistant requests
- **AI_Service**: External AI service integration (OpenAI, Claude, or similar) for natural language processing
- **Insight**: A detected pattern, urgency indicator, or behavioral observation from email analysis
- **Smart_Action**: A recommended action with reasoning based on email analysis
- **System_Optimization**: Data cleanup and storage efficiency recommendations

## Requirements

### Requirement 1: Email Data Analysis

**User Story:** As a user, I want the AI assistant to analyze my stored emails, so that I can understand the current state of my email communications.

#### Acceptance Criteria

1. WHEN the user requests email analysis, THE Analysis_Engine SHALL retrieve emails from the Email_Cache table
2. THE Analysis_Engine SHALL prioritize emails from the last 48 hours for analysis
3. THE Analysis_Engine SHALL detect urgency levels in email content and metadata
4. THE Analysis_Engine SHALL detect sentiment (positive, negative, neutral, dissatisfied) in email body text
5. THE Analysis_Engine SHALL detect intent (inquiry, complaint, opportunity, follow-up, informational) from email content
6. THE Analysis_Engine SHALL identify unread emails and calculate unread duration
7. THE Analysis_Engine SHALL detect missed reply opportunities based on received emails without responses
8. THE Analysis_Engine SHALL identify high-value leads based on email content patterns and sender information
9. THE Analysis_Engine SHALL detect clutter and inefficiencies (promotional emails, system notifications, redundant threads)
10. FOR ALL email analysis operations, THE Analysis_Engine SHALL complete processing within 30 seconds for up to 500 emails

### Requirement 2: Response Generation

**User Story:** As a user, I want the AI assistant to provide decision-driven responses, so that I receive actionable insights without ambiguity.

#### Acceptance Criteria

1. THE Response_Formatter SHALL generate responses that NEVER contain questions
2. THE Response_Formatter SHALL produce complete sentences ending with ".", "!", or "?"
3. THE Response_Formatter SHALL NOT produce incomplete or truncated responses
4. WHEN generating insights, THE Response_Formatter SHALL categorize findings as urgent (🔴), follow-ups (🟡), or behavioral patterns (📈)
5. THE Response_Formatter SHALL generate 2-4 lines of summary about overall email system health
6. THE Response_Formatter SHALL generate between 3 and 6 insights based on analysis results
7. THE Response_Formatter SHALL generate between 3 and 4 smart actions with clear reasoning
8. THE Response_Formatter SHALL include system optimization recommendations for data cleanup and storage efficiency
9. THE Response_Formatter SHALL maintain a confident, direct, and intelligent tone (JARVIS-style)
10. THE Response_Formatter SHALL format all output according to the strict output template

### Requirement 3: Output Format Compliance

**User Story:** As a user, I want consistent, structured output from the AI assistant, so that I can quickly scan and understand the insights.

#### Acceptance Criteria

1. THE Response_Formatter SHALL structure output with exactly four sections: Summary, Insights, Smart Actions, and System Optimization
2. THE Response_Formatter SHALL format the Summary section with 2-4 lines about email system health
3. THE Response_Formatter SHALL format the Insights section as a bulleted list with emoji indicators (🔴, 🟡, 📈)
4. THE Response_Formatter SHALL format the Smart Actions section as a numbered list (1-4 items) with action and reason
5. THE Response_Formatter SHALL format the System Optimization section as a bulleted list with cleanup and efficiency recommendations
6. THE Response_Formatter SHALL use exactly the section headers: "Summary:", "Insights:", "Smart Actions (JARVIS Style):", "System Optimization:"
7. THE Response_Formatter SHALL separate sections with blank lines for readability
8. THE Response_Formatter SHALL NOT deviate from the prescribed output format structure
9. THE Response_Formatter SHALL ensure all text is properly formatted with correct punctuation
10. FOR ALL output generation, THE Response_Formatter SHALL validate format compliance before returning results

### Requirement 4: System Hygiene and Data Cleanup

**User Story:** As a system administrator, I want the AI assistant to recommend data cleanup actions, so that the email cache remains efficient and storage is optimized.

#### Acceptance Criteria

1. THE Cleanup_Manager SHALL identify emails eligible for deletion after analysis
2. THE Cleanup_Manager SHALL mark analyzed emails with a deletion recommendation flag in the Email_Cache table
3. THE Cleanup_Manager SHALL recommend deletion of emails older than 7 days that have been analyzed
4. THE Cleanup_Manager SHALL recommend retention of emails marked as high-value leads or requiring follow-up
5. THE Cleanup_Manager SHALL calculate storage savings from recommended cleanup actions
6. THE Cleanup_Manager SHALL generate cleanup recommendations following the "Reduce, Reuse, Recycle" principle
7. THE Cleanup_Manager SHALL recommend archiving important insights rather than raw email data
8. THE Cleanup_Manager SHALL identify redundant email data (duplicate threads, promotional clutter)
9. WHEN generating system optimization recommendations, THE Cleanup_Manager SHALL provide specific counts and storage estimates
10. THE Cleanup_Manager SHALL NOT automatically delete emails without user confirmation

### Requirement 5: Backend API Integration

**User Story:** As a developer, I want a RESTful API endpoint for the AI assistant, so that the frontend can request email analysis.

#### Acceptance Criteria

1. THE Backend_API SHALL provide a POST endpoint at `/api/outlook/ai-assistant/analyze`
2. WHEN the analyze endpoint is called, THE Backend_API SHALL authenticate the request using existing JWT middleware
3. THE Backend_API SHALL accept optional parameters: `timeframe` (default: 48 hours), `includeRead` (default: true), `maxEmails` (default: 500)
4. THE Backend_API SHALL query the Email_Cache table with appropriate filters based on request parameters
5. THE Backend_API SHALL invoke the AI_Service with email data and analysis instructions
6. THE Backend_API SHALL return analysis results in JSON format with fields: `summary`, `insights`, `smartActions`, `systemOptimization`, `analyzedCount`, `timestamp`
7. IF the Email_Cache table is empty, THEN THE Backend_API SHALL return a friendly message indicating no emails to analyze
8. IF the AI_Service request fails, THEN THE Backend_API SHALL return an error response with status 500 and error details
9. THE Backend_API SHALL log all AI assistant requests to the activity log service
10. THE Backend_API SHALL implement rate limiting of 10 requests per minute per user to prevent AI service abuse

### Requirement 6: AI Service Integration

**User Story:** As a developer, I want integration with external AI services, so that the system can perform natural language processing on email content.

#### Acceptance Criteria

1. THE AI_Service SHALL support integration with OpenAI GPT models (GPT-4 or GPT-3.5-turbo)
2. THE AI_Service SHALL support integration with Anthropic Claude models as an alternative
3. THE AI_Service SHALL load API credentials from environment variables (`AI_SERVICE_PROVIDER`, `AI_SERVICE_API_KEY`, `AI_SERVICE_MODEL`)
4. WHEN sending email data to the AI service, THE AI_Service SHALL include system instructions enforcing response format and behavior rules
5. THE AI_Service SHALL include instructions to NEVER ask questions in responses
6. THE AI_Service SHALL include instructions to ALWAYS complete sentences properly
7. THE AI_Service SHALL include instructions to think deeply before answering to simulate human-like reasoning
8. THE AI_Service SHALL limit email content sent to the AI service to 100KB per request to manage token usage
9. IF the AI service response is incomplete or malformed, THEN THE AI_Service SHALL retry once with adjusted parameters
10. THE AI_Service SHALL implement timeout handling with a 45-second maximum wait time per request

### Requirement 7: Dashboard UI Integration

**User Story:** As a user, I want to access the AI assistant from the dashboard, so that I can analyze my emails without leaving the interface.

#### Acceptance Criteria

1. THE Dashboard_UI SHALL provide a button or menu item labeled "AI Email Assistant" in the Outlook section
2. WHEN the user clicks the AI Email Assistant button, THE Dashboard_UI SHALL display a modal or dedicated panel
3. THE Dashboard_UI SHALL show a loading indicator while analysis is in progress
4. WHEN analysis completes, THE Dashboard_UI SHALL display the formatted results in the modal/panel
5. THE Dashboard_UI SHALL preserve formatting of the four output sections (Summary, Insights, Smart Actions, System Optimization)
6. THE Dashboard_UI SHALL render emoji indicators (🔴, 🟡, 📈) correctly in the Insights section
7. THE Dashboard_UI SHALL provide a "Refresh Analysis" button to re-run analysis with current data
8. THE Dashboard_UI SHALL provide a "Close" button to dismiss the AI assistant modal/panel
9. IF the analysis request fails, THEN THE Dashboard_UI SHALL display an error message with retry option
10. THE Dashboard_UI SHALL display the timestamp of the last analysis at the bottom of the results

### Requirement 8: Email Cache Table Schema

**User Story:** As a developer, I want the email cache table to support AI assistant operations, so that analysis and cleanup can be performed efficiently.

#### Acceptance Criteria

1. THE Email_Cache table SHALL include a column `ai_analyzed_at` (TIMESTAMPTZ) to track when an email was last analyzed
2. THE Email_Cache table SHALL include a column `ai_cleanup_recommended` (BOOLEAN DEFAULT FALSE) to flag emails for deletion
3. THE Email_Cache table SHALL include a column `ai_priority_score` (SMALLINT) to store calculated priority (0-100)
4. THE Email_Cache table SHALL include a column `ai_detected_intent` (VARCHAR(50)) to store detected intent category
5. THE Email_Cache table SHALL include a column `ai_detected_sentiment` (VARCHAR(30)) to store detected sentiment
6. THE Email_Cache table SHALL maintain existing columns: `id`, `conversation_id`, `subject`, `from_address`, `from_name`, `to_recipients`, `cc_recipients`, `received_datetime`, `sent_datetime`, `is_read`, `body_preview`, `has_attachments`, `importance`, `folder`, `category`, `synced_at`
7. THE Email_Cache table SHALL create an index on `ai_analyzed_at` for efficient query performance
8. THE Email_Cache table SHALL create an index on `received_datetime` for time-based filtering
9. WHEN the AI assistant analyzes an email, THE Backend_API SHALL update the `ai_analyzed_at` timestamp
10. WHEN the Cleanup_Manager recommends deletion, THE Backend_API SHALL set `ai_cleanup_recommended` to TRUE

### Requirement 9: Deep Thinking and Human-like Reasoning

**User Story:** As a user, I want the AI assistant to provide thoughtful, well-reasoned insights, so that recommendations feel intelligent and trustworthy.

#### Acceptance Criteria

1. THE Analysis_Engine SHALL process email context including sender history, thread continuity, and temporal patterns
2. THE Analysis_Engine SHALL consider email metadata (importance flags, read status, attachment presence) in priority scoring
3. THE Analysis_Engine SHALL identify patterns across multiple emails (recurring senders, topic clusters, response time trends)
4. WHEN generating smart actions, THE Response_Formatter SHALL provide specific reasoning based on detected patterns
5. THE Response_Formatter SHALL avoid generic recommendations and provide context-specific actions
6. THE Response_Formatter SHALL prioritize actionable insights over descriptive observations
7. THE Response_Formatter SHALL connect insights to business impact (missed opportunities, customer satisfaction, efficiency)
8. THE Analysis_Engine SHALL weight recent emails (last 48 hours) more heavily than older emails in pattern detection
9. THE Analysis_Engine SHALL identify anomalies (unusual sender behavior, sudden urgency spikes, response delays)
10. FOR ALL analysis operations, THE Analysis_Engine SHALL apply multi-factor scoring combining urgency, sentiment, intent, and temporal factors

### Requirement 10: Error Handling and Resilience

**User Story:** As a user, I want the AI assistant to handle errors gracefully, so that temporary failures don't disrupt my workflow.

#### Acceptance Criteria

1. IF the Email_Cache table is unavailable, THEN THE Backend_API SHALL return a 503 error with message "Email cache temporarily unavailable"
2. IF the AI_Service is unavailable, THEN THE Backend_API SHALL return a 503 error with message "AI service temporarily unavailable. Please try again."
3. IF the AI_Service returns an invalid response, THEN THE Backend_API SHALL log the error and return a fallback response with basic email statistics
4. IF the database query times out, THEN THE Backend_API SHALL return a 504 error with message "Analysis request timed out. Try reducing the timeframe."
5. IF the user requests analysis with no emails in the specified timeframe, THEN THE Backend_API SHALL return a 200 response with message "No emails found in the specified timeframe."
6. THE Backend_API SHALL validate all input parameters and return 400 errors for invalid values
7. THE Backend_API SHALL catch and log all unexpected errors without exposing internal details to the client
8. THE Dashboard_UI SHALL display user-friendly error messages for all error response codes
9. THE Dashboard_UI SHALL provide a "Retry" button when recoverable errors occur
10. THE Backend_API SHALL implement circuit breaker pattern for AI_Service calls to prevent cascading failures

