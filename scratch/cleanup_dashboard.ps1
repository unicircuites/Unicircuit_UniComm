$path = "c:\Users\unius\Documents\code workout\UNI_CRM\dashboard.html"
$content = Get-Content $path -Raw

# This is a very specific pattern for the corrupted block
$pattern = 'function waMediaHTML\(type, body, msgId, mediaPath\) \{\s+var token = localStorage\.getItem\(''unicomm_token''\)[^}]+\}\s+return ''<div[^>]+>🎵 Voice message</div>'';\s+\}'

# Actually, the block is larger. Let's just look for the first occurrence of the corruption.
# 13644 to 13649 is:
# function waMediaHTML(type, body, msgId, mediaPath) {
#   var token = localStorage.getItem('unicomm_token') || sessionStorage.getItem('unicomm_token') || localStorage.getItem('uc_token') || sessionStorage.getItem('uc_token') || '';
#       '</div>';
#     }
#     return '<div style="background:rgba(255,255,255,0.06);border-radius:8px;padding:10px;font-size:13px;">🎵 Voice message</div>';
#   }

$corrupted = "function waMediaHTML(type, body, msgId, mediaPath) {`r`n  var token = localStorage.getItem('unicomm_token') || sessionStorage.getItem('unicomm_token') || localStorage.getItem('uc_token') || sessionStorage.getItem('uc_token') || '';`r`n      '</div>';`r`n    }`r`n    return '<div style=""background:rgba(255,255,255,0.06);border-radius:8px;padding:10px;font-size:13px;"">🎵 Voice message</div>';`r`n  }"

# Wait, `r`n might be just `n.
# Let's try to find and remove it.

# Actually, I'll just use a regex to find the `waMediaHTML` that has the `'</div>';` inside it.
$newContent = $content -replace '(?s)function waMediaHTML\(type, body, msgId, mediaPath\) \{\s+var token = [^;]+;\s+''</div>'';\s+\}\s+return ''<div[^>]+>🎵 Voice message</div>'';\s+\}', ''

# And then the duplicated waAppendMessage after it.
$newContent = $newContent -replace '(?s)function waAppendMessage\(msg\) \{.*?area\.scrollTop = area\.scrollHeight;\s+\}', ''

Set-Content $path $newContent -NoNewline
