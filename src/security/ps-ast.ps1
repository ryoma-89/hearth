# Hearth PowerShell AST extractor.
# Reads a PowerShell script (UTF-8) from stdin, parses it with PowerShell's own
# parser, and prints one JSON object describing every command invocation.
# Nothing in the input is executed. Constructs whose effect cannot be known
# statically are reported in "dynamic" so the caller can fail closed.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$stdin = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false))
$source = $stdin.ReadToEnd()

$tokens = $null
$errors = $null
try {
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
} catch {
    @{ status = 'parse_failed'; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 0
}
if ($errors -and $errors.Count -gt 0) {
    @{ status = 'parse_errors'; message = ($errors | Select-Object -First 3 | ForEach-Object { $_.Message }) -join '; ' } | ConvertTo-Json -Compress
    exit 0
}

$commands = New-Object System.Collections.ArrayList
$dynamic = New-Object System.Collections.ArrayList
$dotnet = New-Object System.Collections.ArrayList

$cmdAsts = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)
foreach ($c in $cmdAsts) {
    $elements = $c.CommandElements
    $first = $elements[0]
    $name = $null
    if ($first -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        $name = $first.Value
    } else {
        [void]$dynamic.Add("dynamic command name: $($first.Extent.Text)")
        $name = '<dynamic>'
    }
    $words = New-Object System.Collections.ArrayList
    for ($i = 1; $i -lt $elements.Count; $i++) {
        $e = $elements[$i]
        if ($e -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            [void]$words.Add($e.Value)
        } elseif ($e -is [System.Management.Automation.Language.CommandParameterAst]) {
            [void]$words.Add('-' + $e.ParameterName)
            if ($e.Argument) { [void]$words.Add($e.Argument.Extent.Text) }
        } elseif ($e -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
            [void]$words.Add($e.Value)
        } elseif ($e -is [System.Management.Automation.Language.ArrayLiteralAst] -and -not ($e.Elements | Where-Object { $_ -isnot [System.Management.Automation.Language.StringConstantExpressionAst] })) {
            # 'a','b' passes several literal arguments; lower each one.
            foreach ($item in $e.Elements) { [void]$words.Add($item.Value) }
        } else {
            [void]$words.Add($e.Extent.Text)
        }
    }
    [void]$commands.Add(@{ name = $name; args = @($words); invocation = $c.InvocationOperator.ToString() })
}

$members = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)
foreach ($m in $members) {
    if ($m.Static) {
        [void]$dotnet.Add("$($m.Expression.Extent.Text)::$($m.Member.Extent.Text)")
    }
}

@{ status = 'ok'; commands = @($commands); dynamic = @($dynamic); dotnet = @($dotnet) } | ConvertTo-Json -Compress -Depth 6
