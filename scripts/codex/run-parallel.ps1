$jobs = @(
  Start-Job -ScriptBlock { bash scripts/codex/01_parser.sh },
  Start-Job -ScriptBlock { bash scripts/codex/02_layout.sh },
  Start-Job -ScriptBlock { bash scripts/codex/03_semantic.sh },
  Start-Job -ScriptBlock { bash scripts/codex/04_reading_order.sh },
  Start-Job -ScriptBlock { bash scripts/codex/05_tag_builder.sh },
  Start-Job -ScriptBlock { bash scripts/codex/06_pdf_writer.sh },
  Start-Job -ScriptBlock { bash scripts/codex/07_validator.sh }
)

$jobs | Wait-Job | Receive-Job

