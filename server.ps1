$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:8080/")

try {
    $listener.Start()
} catch {
    Write-Host "端口8080被占用，请关闭后重试"
    Read-Host "按回车退出"
    exit
}

Write-Host "========================================"
Write-Host "  魔王S 改枪码查询 v8.4.0 - 服务已启动"
Write-Host "  http://localhost:8080/gun_search.html"
Write-Host "  关闭此窗口即可停止服务"
Write-Host "========================================"

function Get-MimeType($ext) {
    switch ($ext) {
        '.html' { return 'text/html; charset=utf-8' }
        '.js'   { return 'application/javascript' }
        '.css'  { return 'text/css' }
        '.png'  { return 'image/png' }
        '.jpg'  { return 'image/jpeg' }
        '.ico'  { return 'image/x-icon' }
        '.json' { return 'application/json; charset=utf-8' }
        default { return 'application/octet-stream' }
    }
}

# 标准枪名关键词列表
$gunKeywords = @(
    @{name="M14射手步枪"; keys=@("M14")},
    @{name="M7战斗步枪"; keys=@("M7")},
    @{name="M4A1突击步枪"; keys=@("M4A1")},
    @{name="M249轻机枪"; keys=@("M249")},
    @{name="M250通用机枪"; keys=@("M250")},
    @{name="AS Val突击步枪"; keys=@("AS Val","ASVAL","AS-VAL")},
    @{name="ASh-12战斗步枪"; keys=@("ASh-12","ASH-12")},
    @{name="AK-12突击步枪"; keys=@("AK-12")},
    @{name="AKM突击步枪"; keys=@("AKM")},
    @{name="AKS-74U突击步枪"; keys=@("AKS-74U")},
    @{name="AR57突击步枪"; keys=@("AR57","AR-57")},
    @{name="AUG突击步枪"; keys=@("AUG")},
    @{name="CAR-15突击步枪"; keys=@("CAR-15")},
    @{name="G18"; keys=@("G18")},
    @{name="G3战斗步枪"; keys=@("G3")},
    @{name="K416突击步枪"; keys=@("K416")},
    @{name="K437突击步枪"; keys=@("K437")},
    @{name="KC17突击步枪"; keys=@("KC17","kc17")},
    @{name="MCX LT突击步枪"; keys=@("MCX LT","MCXLT","MCX")},
    @{name="MK47突击步枪"; keys=@("MK47")},
    @{name="MK4冲锋枪"; keys=@("MK4")},
    @{name="MP5冲锋枪"; keys=@("MP5")},
    @{name="MP7冲锋枪"; keys=@("MP7")},
    @{name="Mini-14射手步枪"; keys=@("Mini-14")},
    @{name="P90冲锋枪"; keys=@("P90")},
    @{name="PKM通用机枪"; keys=@("PKM")},
    @{name="PTR-32突击步枪"; keys=@("PTR-32","PTR")},
    @{name="QBZ95-1突击步枪"; keys=@("QBZ95-1","QBZ")},
    @{name="QCQ171冲锋枪"; keys=@("QCQ171","QCQ")},
    @{name="QJB201轻机枪"; keys=@("QJB201","QJB")},
    @{name="RM277突击步枪"; keys=@("RM277")},
    @{name="SCAR-H战斗步枪"; keys=@("SCAR-H","SCAR")},
    @{name="SG552突击步枪"; keys=@("SG552")},
    @{name="SKS射手步枪"; keys=@("SKS")},
    @{name="SMG-45冲锋枪"; keys=@("SMG-45","SMG")},
    @{name="SR-25射手步枪"; keys=@("SR-25")},
    @{name="SR-3M紧凑突击步枪"; keys=@("SR-3M")},
    @{name="SVCH精确射手步枪"; keys=@("SVCH")},
    @{name="SVD狙击步枪"; keys=@("SVD")},
    @{name="UZI冲锋枪"; keys=@("UZI")},
    @{name="Vector冲锋枪"; keys=@("Vector")},
    @{name="VSS射手步枪"; keys=@("VSS")},
    @{name="勇士冲锋枪"; keys=@("勇士")},
    @{name="腾龙突击步枪"; keys=@("腾龙")},
    @{name="野牛冲锋枪"; keys=@("野牛")}
)

function Get-GunName($code) {
    $parts = $code -split "-"
    $nameParts = @()
    $skipList = @("烽火地带","烽火地 带","烽火地帶","烽 火地带","烽火带带","烽火地 帯")
    foreach ($p in $parts) {
        if ($p -match "^[A-Z0-9]{10,}$") { break }
        $clean = $p.Trim() -replace "\u00A0", " "
        if ($clean -and $clean -notin $skipList) { $nameParts += $clean }
    }
    $rawName = ($nameParts -join "-").Trim("-").Trim()
    if (-not $rawName) { return "" }
    
    # 用关键词匹配标准化枪名
    foreach ($gun in $gunKeywords) {
        foreach ($key in $gun.keys) {
            if ($rawName -like "*$key*") { return $gun.name }
        }
    }
    return $rawName
}

function Escape-CSV-Field($v) {
    $v = "$v".Trim() -replace "[\r\n]"," "
    if ($v -match '[,"\r\n]') { return '"' + $v.Replace('"','""') + '"' }
    return $v
}



# $mode/$source 非空时直接写进每条记录，省掉 /api/data 里 JSON 反序列化 + Add-Member 再序列化的来回转换
function Parse-CSV($csvPath, $mode = '', $source = '') {
    if (-not (Test-Path $csvPath)) { return '[]' }
    
    $lines = Get-Content $csvPath -Encoding UTF8
    if ($lines.Count -lt 2) { return '[]' }
    
    # 自动检测分隔符（逗号 or Tab）
    $sample = $lines | Where-Object { $_.Trim() } | Select-Object -First 20
    $tabCount = ($sample | ForEach-Object { ($_ -split "`t").Count - 1 } | Measure-Object -Sum).Sum
    $commaCount = ($sample | ForEach-Object { ($_ -split ",").Count - 1 } | Measure-Object -Sum).Sum
    $sep = if ($tabCount -gt $commaCount) { "`t" } else { "," }

    function Parse-CSVLine($line) {
        $fields = [System.Collections.Generic.List[string]]::new()
        $inQuote = $false
        $current = [System.Text.StringBuilder]::new()
        foreach ($char in $line.ToCharArray()) {
            if ($char -eq '"') { $inQuote = -not $inQuote }
            elseif ("$char" -eq $sep -and -not $inQuote) { $fields.Add($current.ToString()); $current = [System.Text.StringBuilder]::new() }
            else { [void]$current.Append($char) }
        }
        $fields.Add($current.ToString())
        return ,$fields.ToArray()
    }
    
    $headerRow = -1
    $colCode = 0; $colPrice = 1; $colAmmo = 2; $colNote = 3; $colDate = 4; $colGunId = -1; $colGunIdHeader = -1; $colSpecialGunId = -1
    
    for ($i = 0; $i -lt [Math]::Min($lines.Count, 30); $i++) {
        if ($lines[$i] -match "改枪码" -and $lines[$i] -match "价格") {
            $headerRow = $i
            $fields = Parse-CSVLine $lines[$i]
            for ($j = 0; $j -lt $fields.Count; $j++) {
                $v = $fields[$j].Trim()
                if ($v -match "改枪码" -and $v -match "游戏") { $colCode = $j }
                elseif ($v -eq "价格") { $colPrice = $j }
                elseif ($v -match "弹夹") { $colAmmo = $j }
                elseif ($v -match "备注") { $colNote = $j }
                elseif ($v -match "日期") { $colDate = $j }
                elseif ($v -match "特殊子弹ID") {
                    $colSpecialGunId = $j
                }
                elseif (($v -match "控枪编号" -or $v -match "ID") -and $v -notmatch "特殊" -and $v -notmatch "数据") {
                    $colGunIdHeader = $j
                }
            }
            break
        }
    }
    
    if ($headerRow -lt 0) { return '[]' }
    
    if ($colGunIdHeader -ge 0) {
        $colGunId = $colGunIdHeader
        for ($i = $headerRow + 1; $i -lt [Math]::Min($lines.Count, $headerRow + 10); $i++) {
            $f = Parse-CSVLine $lines[$i]
            $vCur  = if ($f.Count -gt $colGunIdHeader) { $f[$colGunIdHeader].Trim() } else { "" }
            $vNext = if ($f.Count -gt ($colGunIdHeader + 1)) { $f[$colGunIdHeader + 1].Trim() } else { "" }
            if ($vNext -match "^[0-9]+$" -and $vCur -notmatch "^[0-9]+$") { $colGunId = $colGunIdHeader + 1; break }
            elseif ($vCur -match "^[0-9]+$") { $colGunId = $colGunIdHeader; break }
        }
    }
    
    # 用 List 而不是 @() + 的原因：PowerShell 的 $array += $item 每次都会整份拷贝数组，
    # 循环里用就是 O(n²)；sheet 记录数一旦上千（比如 3635 条的合集表），这个坑会让整个
    # 请求卡到肉眼可见地慢。List.Add() 是均摊 O(1)，后面管道进 ConvertTo-Json/Where-Object
    # 用法不用变。
    $records = [System.Collections.Generic.List[object]]::new()
    # 已出现的改枪码：制式套扫描去重用 HashSet 查找，替代原来每行一次 $records | Where-Object（O(n²)）
    $seenCodes = [System.Collections.Generic.HashSet[string]]::new()

    for ($i = $headerRow + 1; $i -lt $lines.Count; $i++) {
        $line = $lines[$i].Trim()
        if (-not $line) { continue }
        
        $fields = Parse-CSVLine $line
        
        $code  = if ($fields.Count -gt $colCode)  { $fields[$colCode].Trim()  -replace "[\r\n]"," " } else { "" }
        $price = if ($fields.Count -gt $colPrice) { $fields[$colPrice].Trim() -replace "[\r\n]"," " } else { "" }
        $ammo  = if ($fields.Count -gt $colAmmo)  { $fields[$colAmmo].Trim()  -replace "[\r\n]"," " } else { "" }
        $note  = if ($fields.Count -gt $colNote)  { $fields[$colNote].Trim()  -replace "[\r\n]"," " } else { "" }
        $date  = if ($fields.Count -gt $colDate)  { $fields[$colDate].Trim()  -replace "[\r\n]"," " } else { "" }
        $gunId = if ($colGunId -ge 0 -and $fields.Count -gt $colGunId) { $fields[$colGunId].Trim() -replace "[\r\n]"," " } else { "" }
        $specialGunId = if ($colSpecialGunId -ge 0 -and $fields.Count -gt $colSpecialGunId) { $fields[$colSpecialGunId].Trim() -replace "[\r\n]"," " } else { "" }
        
        if (-not $code -or $code -notmatch "[A-Z0-9]{5,}") { continue }
        
        # 跳过制式套行（col2是等级名的行，留给后面单独处理）
        $zhishiCheck = @("新兵","标准","精锐","特种","定制")
        $col2Check = if ($fields.Count -gt 2) { $fields[2].Trim() } else { "" }
        if ($zhishiCheck -contains $col2Check) { continue }
        
        $gunName = Get-GunName $code
        if (-not $gunName) { continue }

        # 过滤分隔标题行：price/ammo/date/note 全为空说明是占位行
        if (-not $price -and -not $ammo -and -not $date -and -not $note) { continue }
        
        $codeMatch = [regex]::Match($code, "[A-Z0-9]{10,}")
        $newCode = if ($codeMatch.Success) { "$gunName-烽火地带-$($codeMatch.Value)" } else { $code }
        
        # 制式套识别：价格列直接是等级名
        $zhishiLevels = @("新兵","标准","精锐","特种","定制")
        $isZhishi = $zhishiLevels -contains $price
        if ($isZhishi) {
            # 制式套数据：列2=等级 列7=控枪编号，重新读取
            $gunId = if ($fields.Count -gt 7) { $fields[7].Trim() -replace "[\r\n]"," " } else { $gunId }
            $note  = if ($fields.Count -gt 3) { $fields[3].Trim() -replace "[\r\n]"," " } else { "" }
            $ammo  = ""
            $date  = ""
        }
        
        $priceMatch = [regex]::Match($price, "[0-9]+")
        $priceVal = if ($priceMatch.Success) { [int]$priceMatch.Value } else { 0 }
        
        $ammoNums = [regex]::Matches($ammo, "[0-9]+") | ForEach-Object { [int]$_.Value }
        $ammoVal = if ($ammoNums.Count -gt 0) { ($ammoNums | Measure-Object -Maximum).Maximum } else { 0 }
        
        $dateMatch = [regex]::Match($date, "([0-9]+)[/年]([0-9]+)")
        $dateVal = if ($dateMatch.Success) { [int]$dateMatch.Groups[1].Value * 100 + [int]$dateMatch.Groups[2].Value } else { 0 }
        
        $obj = @{
            code       = $newCode
            gunName    = $gunName
            price      = $price
            priceVal   = $priceVal
            ammo       = $ammo
            ammoVal    = $ammoVal
            note       = $note
            date       = $date
            dateVal    = $dateVal
            gunId      = if ($gunId -and $gunId -ne "nan") { $gunId } else { "" }
            specialGunId = if ($specialGunId -and $specialGunId -ne "nan") { $specialGunId } else { "" }
            sheet      = [System.IO.Path]::GetFileNameWithoutExtension($csvPath)
            hasJiao    = ($note -notmatch "无精校")
            hasPingxi  = ($note -match "屏息")
            hasXiaoyin = ($note -match "消音")
            hasYao     = ($note -match "腰射")
        }
        if ($mode) { $obj['mode'] = $mode; $obj['source'] = $source }
        [void]$seenCodes.Add([string]$newCode)
        $records.Add($obj)
    }

    # 扫描所有行，找制式套数据（价格列=等级名的行）
    $zhishiLevels = @("新兵","标准","精锐","特种","定制")
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i].Trim()
        if (-not $line) { continue }
        # 用简单分割扫描制式套（避免作用域问题）
        $fields = $line -split ","
        if ($fields.Count -lt 3) { continue }
        
        $col0 = $fields[0].Trim()
        $col2 = if ($fields.Count -gt 2) { $fields[2].Trim() } else { "" }
        $col7 = if ($fields.Count -gt 7) { $fields[7].Trim() } else { "" }
        
        # 制式套行：列0有改枪码，列2是等级名
        if ($col0 -match "[A-Z0-9]{10,}" -and $zhishiLevels -contains $col2) {
            $gunName = Get-GunName $col0
            if (-not $gunName) { continue }
            
            $codeMatch = [regex]::Match($col0, "[A-Z0-9]{10,}")
            $newCode = if ($codeMatch.Success) { "$gunName-烽火地带-$($codeMatch.Value)" } else { $col0 }
            
            $col3 = if ($fields.Count -gt 3) { $fields[3].Trim() } else { "" }
            
            # 检查是否已经存在相同改枪码（避免重复）
            if ($seenCodes.Contains([string]$newCode)) { continue }
            
            $obj = @{
                code       = $newCode
                gunName    = $gunName
                price      = $col2
                priceVal   = 0
                ammo       = ""
                ammoVal    = 0
                note       = $col3
                date       = ""
                dateVal    = 0
                gunId      = if ($col7 -and $col7 -ne "nan") { $col7 } else { "" }
                sheet      = [System.IO.Path]::GetFileNameWithoutExtension($csvPath)
                hasJiao    = $true
                hasPingxi  = $false
                hasXiaoyin = $false
                hasYao     = $false
            }
            if ($mode) { $obj['mode'] = $mode; $obj['source'] = $source }
            [void]$seenCodes.Add([string]$newCode)
            $records.Add($obj)
        }
    }

    # -InputObject 保证始终输出 JSON 数组（管道方式 1 条时会退化成单个对象，0 条时输出空）
    return (ConvertTo-Json -InputObject $records.ToArray() -Compress)
}


function Get-ModeFromName($name) {
    $n = [string]$name
    if ($n -match '全面战场') { return '全面战场' }
    if ($n -match '爆破') { return '爆破' }
    return '烽火地带'
}

function Get-SafeName($name, $fallback='未命名') {
    $safe = ([string]$name) -replace '[\\/:*?"<>|]', '_' -replace '\s+', ' '
    $safe = $safe.Trim()
    if ([string]::IsNullOrWhiteSpace($safe)) { $safe = $fallback }
    if ($safe.Length -gt 80) { $safe = $safe.Substring(0,80) }
    return $safe
}

function Ensure-DataTree() {
    $dataDir = Join-Path $dir 'data'
    foreach ($sub in @('tx','my','烽火地带','全面战场','爆破')) {
        $path = if ($sub -in @('烽火地带','全面战场','爆破')) { Join-Path (Join-Path $dataDir 'tx') $sub } else { Join-Path $dataDir $sub }
        if (-not (Test-Path $path)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
    }
    foreach ($file in @('favorites.json','invalid.json','config.json')) {
        $path = Join-Path $dataDir $file
        if (-not (Test-Path $path)) {
            if ($file -eq 'config.json') { '{"schemaVersion":2,"defaultMode":"烽火地带"}' | Out-File $path -Encoding UTF8 }
            else { '[]' | Out-File $path -Encoding UTF8 }
        }
    }
}

function Migrate-LegacyCsv() {
    $dataDir = Join-Path $dir 'data'
    if (-not (Test-Path $dataDir)) { return }
    $legacy = Get-ChildItem -Path $dataDir -Filter '*.csv' -File -ErrorAction SilentlyContinue
    foreach ($f in $legacy) {
        $name = $f.BaseName
        $mode = Get-ModeFromName $name
        $source = if ($name -eq '自定义' -or $name -match '^手动') { 'my' } else { 'tx' }
        $targetDir = Join-Path (Join-Path $dataDir $source) $mode
        if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
        $target = Join-Path $targetDir ((Get-SafeName $name) + '.csv')
        if (-not (Test-Path $target)) {
            try { Move-Item -LiteralPath $f.FullName -Destination $target -Force } catch { Copy-Item -LiteralPath $f.FullName -Destination $target -Force }
        } else {
            try { Remove-Item -LiteralPath $f.FullName -Force } catch { }
        }
    }
}

function Read-JsonArray($path) {
    if (-not (Test-Path $path)) { return @() }
    try { $v = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json; return @($v) } catch { return @() }
}

function Write-JsonArray($path, $items) {
    $items = @($items)
    ($items | ConvertTo-Json -Depth 20 -Compress) | Out-File -LiteralPath $path -Encoding UTF8
}

function Get-RecordKey($r) {
    return "$(if($r.mode){$r.mode}else{'烽火地带'})|$([string]$r.code)"
}

function Send-Response($ctx, $statusCode, $contentType, $body) {
    $ctx.Response.StatusCode = $statusCode
    $ctx.Response.ContentType = $contentType
    $ctx.Response.Headers.Add("Access-Control-Allow-Origin", "*")
    # PowerShell 的空数组经过管道 ConvertTo-Json 后可能得到 $null，导致 GetBytes/Write 报“数组不能为空”。
    # 统一把空响应转换成空字符串；JSON 数组接口在调用处会显式返回 []。
    if ($null -eq $body) { $body = "" }
    else { $body = [string]$body }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    if ($bytes.Length -gt 0) {
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
    $ctx.Response.Close()
}

# 读取全部数据的 JSON（tx + my，mode/source 作为一等字段）
# 性能：CSV 只在同步时才会变，所以按文件缓存解析后的 JSON（key=路径，校验=修改时间+大小），
# 文件没变就不重新解析；整体再缓存一份最终 JSON，全部文件没变时几乎是 O(1)。
# 拼接时直接拼各文件 JSON 字符串，不再反序列化/序列化。启动时也会调用一次做预热。
function Get-AllDataJson() {
    Ensure-DataTree
    $dataDir = Join-Path $dir "data"
    $csvFiles = [System.Collections.Generic.List[object]]::new()
    foreach ($source in @('tx','my')) {
        $sourceDir = Join-Path $dataDir $source
        foreach ($mode in @('烽火地带','全面战场','爆破')) {
            $modeDir = Join-Path $sourceDir $mode
            if (-not (Test-Path $modeDir)) { continue }
            foreach ($f in (Get-ChildItem $modeDir -Filter '*.csv' -File -ErrorAction SilentlyContinue)) {
                $csvFiles.Add(@{ file = $f; mode = $mode; source = $source; stamp = "$($f.LastWriteTimeUtc.Ticks)|$($f.Length)" })
            }
        }
    }
    $sig = ($csvFiles | ForEach-Object { "$($_.file.FullName)|$($_.stamp)" }) -join ';'

    if ($script:dataJsonSig -eq $sig -and $script:dataJson) {
        $json = $script:dataJson
    } else {
        $parts = [System.Collections.Generic.List[string]]::new()
        foreach ($e in $csvFiles) {
            $key = $e.file.FullName
            $hit = $script:csvJsonCache[$key]
            if ($hit -and $hit.stamp -eq $e.stamp) {
                $fileJson = $hit.json
            } else {
                try { $fileJson = [string](Parse-CSV $key $e.mode $e.source) } catch { $fileJson = '[]' }
                $script:csvJsonCache[$key] = @{ stamp = $e.stamp; json = $fileJson }
            }
            # 各文件 JSON 都是 [ ... ]，去掉外层括号后用逗号拼成一个大数组；空数组（长度2）跳过
            if ($fileJson -and $fileJson.Length -gt 2) { $parts.Add($fileJson.Substring(1, $fileJson.Length - 2)) }
        }
        $json = '[' + ($parts -join ',') + ']'
        $script:dataJsonSig = $sig
        $script:dataJson = $json
    }
    return $json
}

# 初始化新版数据目录，并迁移旧版根目录 CSV
Ensure-DataTree
Migrate-LegacyCsv

# /api/data 缓存：单文件解析结果 + 最终整包 JSON
$script:csvJsonCache = @{}
$script:dataJsonSig = $null
$script:dataJson = $null

# 预热：启动时先解析一遍并写入缓存，浏览器第一次打开页面就不用再等解析
Write-Host "  正在预热数据缓存..."
$warmSw = [System.Diagnostics.Stopwatch]::StartNew()
try { [void](Get-AllDataJson); Write-Host ("  数据缓存就绪，用时 {0} 毫秒" -f $warmSw.ElapsedMilliseconds) }
catch { Write-Host "  数据预热失败（不影响使用，首次请求时会重新加载）" }

# 预热完成后再打开浏览器
Start-Process "http://localhost:8080/gun_search.html"

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $method = $ctx.Request.HttpMethod
    $path = $ctx.Request.Url.LocalPath

    # OPTIONS 预检
    if ($method -eq "OPTIONS") {
        $ctx.Response.Headers.Add("Access-Control-Allow-Origin", "*")
        $ctx.Response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        $ctx.Response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
        $ctx.Response.StatusCode = 200
        $ctx.Response.Close()
        continue
    }

    # API: 服务健康检查
    if ($path -eq "/api/health" -and $method -eq "GET") {
        Send-Response $ctx 200 "application/json; charset=utf-8" '{"ok":true,"version":"8.4.0"}'
        continue
    }

    # API: 调试制式套解析
    if ($path -eq "/api/debug-zhishi" -and $method -eq "GET") {
        $dataDir = Join-Path $dir "data"
        $result = @()
        foreach ($f in (Get-ChildItem $dataDir -Filter "*.csv")) {
            $lines = Get-Content $f.FullName -Encoding UTF8
            $zhishiLevels = @("新兵","标准","精锐","特种","定制")
            $found = @()
            foreach ($line in $lines) {
                $fields = $line -split ","
                $col0 = if ($fields.Count -gt 0) { $fields[0].Trim() } else { "" }
                $col2 = if ($fields.Count -gt 2) { $fields[2].Trim() } else { "" }
                if ($col0 -match "[A-Z0-9]{10,}" -and $zhishiLevels -contains $col2) {
                    $found += "$col0 | level=$col2"
                }
            }
            $result += "$($f.Name): $($found.Count)条制式套"
            if ($found.Count -gt 0) { $result += $found[0..2] }
        }
        Send-Response $ctx 200 "application/json; charset=utf-8" ($result | ConvertTo-Json -Compress)
        continue
    }

    # API: 获取全部数据（逻辑见 Get-AllDataJson，带缓存）
    if ($path -eq "/api/data" -and $method -eq "GET") {
        try {
            $json = Get-AllDataJson
            Send-Response $ctx 200 "application/json; charset=utf-8" $json
        } catch {
            Send-Response $ctx 500 "application/json; charset=utf-8" '{"ok":false,"err":"读取数据失败"}'
        }
        continue
    }

    # API: 获取/保存收藏夹
    if ($path -eq "/api/favorites" -and $method -eq "GET") {
        Ensure-DataTree
        $items = @(Read-JsonArray (Join-Path $dir 'data/favorites.json'))
        $json = if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Depth 20 -Compress }
        Send-Response $ctx 200 "application/json; charset=utf-8" $json
        continue
    }
    if ($path -eq "/api/favorites" -and $method -eq "POST") {
        try {
            $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream,[System.Text.Encoding]::UTF8); $body=$reader.ReadToEnd(); $reader.Close()
            $data=$body | ConvertFrom-Json
            Ensure-DataTree; Write-JsonArray (Join-Path $dir 'data/favorites.json') @($data.items)
            Send-Response $ctx 200 "application/json; charset=utf-8" '{"ok":true}'
        } catch { Send-Response $ctx 500 "application/json; charset=utf-8" '{"ok":false}' }
        continue
    }

    # API: 获取/保存无效码
    if ($path -eq "/api/invalid" -and $method -eq "GET") {
        Ensure-DataTree
        $items = @(Read-JsonArray (Join-Path $dir 'data/invalid.json'))
        $json = if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Depth 20 -Compress }
        Send-Response $ctx 200 "application/json; charset=utf-8" $json
        continue
    }
    if ($path -eq "/api/invalid" -and $method -eq "POST") {
        try {
            $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream,[System.Text.Encoding]::UTF8); $body=$reader.ReadToEnd(); $reader.Close()
            $data=$body | ConvertFrom-Json
            Ensure-DataTree; Write-JsonArray (Join-Path $dir 'data/invalid.json') @($data.items)
            Send-Response $ctx 200 "application/json; charset=utf-8" '{"ok":true}'
        } catch { Send-Response $ctx 500 "application/json; charset=utf-8" '{"ok":false}' }
        continue
    }

    # API: 手动新增：只写入 my/<mode>/自定义.csv
    if ($path -eq "/api/add" -and $method -eq "POST") {
        try {
            $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream,[System.Text.Encoding]::UTF8); $body=$reader.ReadToEnd(); $reader.Close()
            $data=$body | ConvertFrom-Json
            Ensure-DataTree
            $mode = if ($data.mode) { [string]$data.mode } else { '烽火地带' }
            if ($mode -notin @('烽火地带','全面战场','爆破')) { $mode='烽火地带' }
            $csvPath=Join-Path (Join-Path (Join-Path $dir 'data') 'my') (Join-Path $mode '自定义.csv')
            if (-not (Test-Path $csvPath)) { "改枪码（游戏内使用）,价格,弹夹,备注,日期,控枪编号（网页使用）,特殊子弹ID" | Out-File $csvPath -Encoding UTF8 }
            $line="$(Escape-CSV-Field $data.code),$(Escape-CSV-Field $data.price),$(Escape-CSV-Field $data.ammo),$(Escape-CSV-Field $data.note),$(Escape-CSV-Field $data.date),$(Escape-CSV-Field $data.gunId),$(Escape-CSV-Field $data.specialGunId)"
            Add-Content $csvPath $line -Encoding UTF8
            Send-Response $ctx 200 "application/json; charset=utf-8" ('{"ok":true,"mode":"'+$mode+'"}')
        } catch { Send-Response $ctx 500 "application/json; charset=utf-8" '{"ok":false}' }
        continue
    }

    # API: 清理数据
    if ($path -eq "/api/tencent-sync/reset" -and $method -eq "POST") {
        try {
            Ensure-DataTree; $base=Join-Path (Join-Path $dir 'data') 'tx'; $files=0; $records=0
            foreach ($mode in @('烽火地带','全面战场','爆破')) {
                $md=Join-Path $base $mode
                if (-not (Test-Path $md)) { continue }
                foreach ($f in (Get-ChildItem $md -Filter '*.csv' -File -ErrorAction SilentlyContinue)) {
                    try { $rows=(Get-Content $f.FullName -Encoding UTF8 | Where-Object {$_.Trim()}).Count; $records += [Math]::Max(0,$rows-1); Remove-Item $f.FullName -Force; $files++ } catch { }
                }
            }
            Send-Response $ctx 200 "application/json; charset=utf-8" ((@{ok=$true;files=$files;records=$records})|ConvertTo-Json -Compress)
        } catch { Send-Response $ctx 500 "application/json; charset=utf-8" '{"ok":false}' }
        continue
    }
    if ($path -eq "/api/data/reset" -and $method -eq "POST") {
        try {
            Ensure-DataTree; $base=Join-Path (Join-Path $dir 'data') 'my'; $files=0
            foreach ($mode in @('烽火地带','全面战场','爆破')) { $md=Join-Path $base $mode; if(Test-Path $md){ Get-ChildItem $md -Filter '*.csv' -File -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item $_.FullName -Force; $files++ } } }
            Send-Response $ctx 200 "application/json; charset=utf-8" ((@{ok=$true;files=$files})|ConvertTo-Json -Compress)
        } catch { Send-Response $ctx 500 "application/json; charset=utf-8" '{"ok":false}' }
        continue
    }
    if ($path -eq "/api/favorites/reset" -and $method -eq "POST") {
        Ensure-DataTree; '[]' | Out-File (Join-Path $dir 'data/favorites.json') -Encoding UTF8; Send-Response $ctx 200 "application/json; charset=utf-8" '{"ok":true}'; continue
    }
    if ($path -eq "/api/invalid/reset" -and $method -eq "POST") {
        Ensure-DataTree; '[]' | Out-File (Join-Path $dir 'data/invalid.json') -Encoding UTF8; Send-Response $ctx 200 "application/json; charset=utf-8" '{"ok":true}'; continue
    }
    if ($path -eq "/api/all/reset" -and $method -eq "POST") {
        try {
            foreach($sub in @('tx','my')) { $base=Join-Path (Join-Path $dir 'data') $sub; foreach($mode in @('烽火地带','全面战场','爆破')) { $md=Join-Path $base $mode; if(Test-Path $md){ Get-ChildItem $md -Filter '*.csv' -File -ErrorAction SilentlyContinue | Remove-Item -Force } } }
            '[]'|Out-File (Join-Path $dir 'data/favorites.json') -Encoding UTF8; '[]'|Out-File (Join-Path $dir 'data/invalid.json') -Encoding UTF8
            Send-Response $ctx 200 "application/json; charset=utf-8" '{"ok":true}'
        } catch { Send-Response $ctx 500 "application/json; charset=utf-8" '{"ok":false}' }
        continue
    }

    # API: 腾讯文档同步（由腾讯文档页面中的同步助手调用）
    if ($path -eq "/api/tencent-sync" -and $method -eq "POST") {
        try {
            $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream, [System.Text.Encoding]::UTF8)
            $body = $reader.ReadToEnd()
            $reader.Close()
            $payload = $body | ConvertFrom-Json
            $sheetName = if ($payload.sheetName) { [string]$payload.sheetName } else { "腾讯文档" }
            $records = @($payload.records)
            if ($records.Count -eq 0) {
                Send-Response $ctx 200 "application/json; charset=utf-8" '{"ok":true,"total":0,"added":0,"updated":0,"duplicate":0}'
                continue
            }

            $dataDir = Join-Path $dir "data"
            if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }

            # 每个 Sheet 单独保存，避免后续维护时混在一起。
            $safeSheet = Get-SafeName $sheetName '腾讯文档'
            $mode = if ($payload.mode) { [string]$payload.mode } else { Get-ModeFromName $sheetName }
            if ($mode -notin @('烽火地带','全面战场','爆破')) { $mode = Get-ModeFromName $sheetName }
            $targetDir = Join-Path (Join-Path $dataDir 'tx') $mode
            if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
            $csvPath = Join-Path $targetDir ($safeSheet + '.csv')

            $existingMap = @{}
            if (Test-Path $csvPath) {
                try {
                    $old = Parse-CSV $csvPath | ConvertFrom-Json
                    foreach ($r in @($old)) {
                        if ($r.code) { $existingMap[[string]$r.code] = $r }
                    }
                } catch { }
            }

            $added = 0; $updated = 0; $duplicate = 0
            foreach ($r in $records) {
                $code = [string]$r.code
                if ([string]::IsNullOrWhiteSpace($code)) { continue }
                $price = if ($r.price) { [string]$r.price } else { '' }
                $ammo = if ($r.ammo) { [string]$r.ammo } else { '' }
                $note = if ($r.note) { [string]$r.note } else { '' }
                $date = if ($r.date) { [string]$r.date } else { '' }
                $gunId = if ($r.gunId) { [string]$r.gunId } else { '' }
                $specialGunId = if ($r.specialGunId) { [string]$r.specialGunId } else { '' }
                $normalized = [pscustomobject]@{
                    code = $code
                    price = $price
                    ammo = $ammo
                    note = $note
                    date = $date
                    gunId = $gunId
                    specialGunId = $specialGunId
                }
                if ($existingMap.ContainsKey($code)) {
                    $old = $existingMap[$code]
                    $changed = ([string]$old.price -ne $price) -or ([string]$old.ammo -ne $ammo) -or ([string]$old.note -ne $note) -or ([string]$old.date -ne $date) -or ([string]$old.gunId -ne $gunId) -or ([string]$old.specialGunId -ne $specialGunId)
                    if ($changed) { $updated++ } else { $duplicate++ }
                } else {
                    $added++
                }
                $existingMap[$code] = $normalized
            }

            # List 而不是 @() + ：同一张表反复同步、记录越攒越多（合集表已经3635条），
            # $lines += 这种写法每次都拷贝整个数组，会让同步接口越用越慢
            $lines = [System.Collections.Generic.List[string]]::new()
            $lines.Add("改枪码（游戏内使用）,价格,弹夹,备注,日期,控枪编号（网页使用）,特殊子弹ID")
            foreach ($item in $existingMap.Values) {
                $lines.Add("$(Escape-CSV-Field $item.code),$(Escape-CSV-Field $item.price),$(Escape-CSV-Field $item.ammo),$(Escape-CSV-Field $item.note),$(Escape-CSV-Field $item.date),$(Escape-CSV-Field $item.gunId),$(Escape-CSV-Field $item.specialGunId)")
            }
            $lines | Out-File $csvPath -Encoding UTF8

            $result = @{ ok=$true; total=$records.Count; added=$added; updated=$updated; duplicate=$duplicate; sheet=$sheetName }
            Send-Response $ctx 200 "application/json; charset=utf-8" ($result | ConvertTo-Json -Compress)
        } catch {
            $msg = ($_.Exception.Message -replace '"','\\"')
            Send-Response $ctx 500 "application/json; charset=utf-8" ('{"ok":false,"err":"' + $msg + '"}')
        }
        continue
    }

    # 静态文件
    $reqPath = $path.TrimStart('/')
    if ($reqPath -eq '') { $reqPath = 'gun_search.html' }
    $file = Join-Path $dir $reqPath

    if (Test-Path $file) {
        $ext = [System.IO.Path]::GetExtension($file).ToLower()
        $mime = Get-MimeType $ext
        $content = [System.IO.File]::ReadAllBytes($file)
        $ctx.Response.ContentType = $mime
        $ctx.Response.Headers.Add("Access-Control-Allow-Origin", "*")
        $ctx.Response.OutputStream.Write($content, 0, $content.Length)
        $ctx.Response.Close()
    } else {
        Send-Response $ctx 404 "text/plain" "404 Not Found: $reqPath"
    }
}
