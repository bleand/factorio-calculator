-- Emulates just enough of Factorio's data stage to build `data.raw` from the
-- official prototype definitions (https://github.com/wube/factorio-data),
-- then returns the prototype types the calculator needs as a JSON string.
--
-- Host (extract.mjs) provides these globals:
--   __readfile(path) -> string | nil
--   __root           -> absolute path of the factorio-data checkout
--   __mods           -> comma separated mod list in load order, e.g. "core,base"
--   __versions       -> comma separated versions matching __mods
--   __space_age      -> boolean, enables expansion feature flags

-- Prototype files are third-party code: keep only the traceback helper.
local traceback = debug.traceback
debug = nil

-- ---------------------------------------------------------------- Lua 5.2 shims
unpack = unpack or table.unpack
loadstring = loadstring or load
math.pow = math.pow or function(a, b) return a ^ b end
math.atan2 = math.atan2 or math.atan
math.cosh = math.cosh or function(x) return (math.exp(x) + math.exp(-x)) / 2 end
math.sinh = math.sinh or function(x) return (math.exp(x) - math.exp(-x)) / 2 end
math.tanh = math.tanh or function(x) return (math.exp(x) - math.exp(-x)) / (math.exp(x) + math.exp(-x)) end
math.log10 = math.log10 or function(x) return math.log(x, 10) end
math.ldexp = math.ldexp or function(m, e) return m * 2.0 ^ e end
if not bit32 then
  bit32 = {
    band = function(a, b) return a & b end,
    bor = function(a, b) return a | b end,
    bxor = function(a, b) return a ~ b end,
    lshift = function(a, n) return a << n end,
    rshift = function(a, n) return a >> n end,
    bnot = function(a) return ~a end,
  }
end

-- ------------------------------------------------------------ Factorio globals
function log() end
function table_size(t)
  local n = 0
  for _ in pairs(t) do n = n + 1 end
  return n
end
function table.deepcopy(object)
  local lookup = {}
  local function copy(o)
    if type(o) ~= "table" then return o end
    if lookup[o] then return lookup[o] end
    local new = {}
    lookup[o] = new
    for k, v in pairs(o) do new[copy(k)] = copy(v) end
    return setmetatable(new, getmetatable(o))
  end
  return copy(object)
end
local function str(v) return tostring(v) end
serpent = { block = str, line = str, dump = str }

-- `defines` is engine-provided. Nothing the calculator reads depends on real
-- values, so unknown entries resolve to inert placeholders.
local function placeholder()
  local mt = {}
  mt.__index = function(t, k)
    local v = placeholder()
    rawset(t, k, v)
    return v
  end
  local zero = function() return 0 end
  mt.__add, mt.__sub, mt.__mul, mt.__div, mt.__mod, mt.__unm, mt.__idiv = zero, zero, zero, zero, zero, zero, zero
  mt.__lt = function() return false end
  mt.__le = function() return true end
  mt.__concat = function(a, b)
    return (type(a) == "table" and "" or tostring(a)) .. (type(b) == "table" and "" or tostring(b))
  end
  mt.__tostring = function() return "define" end
  return setmetatable({}, mt)
end
defines = placeholder()
do
  local names = {
    "north", "northnortheast", "northeast", "eastnortheast", "east", "eastsoutheast", "southeast", "southsoutheast",
    "south", "southsouthwest", "southwest", "westsouthwest", "west", "westnorthwest", "northwest", "northnorthwest",
  }
  local direction = {}
  for i, name in ipairs(names) do direction[name] = i - 1 end
  rawset(defines, "direction", direction)
end

mods = {}
do
  local versions = {}
  for v in __versions:gmatch("[^,]+") do versions[#versions + 1] = v end
  local i = 0
  for m in __mods:gmatch("[^,]+") do
    i = i + 1
    if m ~= "core" then mods[m] = versions[i] end
  end
end
settings = { startup = {}, global = {}, player = {} }
feature_flags = {
  quality = __space_age,
  rail_bridges = __space_age,
  space_travel = __space_age,
  spoiling = __space_age,
  freezing = __space_age,
  segmented_units = __space_age,
  expansion_shaders = __space_age,
}

-- --------------------------------------------------------------------- require
local loaded = {}
local dir_stack = {}
local current_mod = "core"

local function dirname(path) return path:match("^(.*)/[^/]*$") or "" end

local function run_file(path, name)
  local src = __readfile(path)
  if not src then return false end
  local cached = loaded[path]
  if cached ~= nil then return true, cached.value end
  local chunk, err = load(src, "@" .. path)
  if not chunk then error(err, 0) end
  dir_stack[#dir_stack + 1] = dirname(path)
  local value = chunk(name)
  dir_stack[#dir_stack] = nil
  if value == nil then value = true end
  loaded[path] = { value = value }
  return true, value
end

function require(name)
  local path = name
  if path:find("/", 1, true) then
    path = path:gsub("%.lua$", "")
  else
    path = path:gsub("%.", "/")
  end
  local candidates = {}
  local mod, rest = path:match("^__([^/]-)__/(.*)$")
  if mod then
    candidates[1] = __root .. "/" .. mod .. "/" .. rest
  else
    if #dir_stack > 0 then candidates[#candidates + 1] = dir_stack[#dir_stack] .. "/" .. path end
    candidates[#candidates + 1] = __root .. "/" .. current_mod .. "/" .. path
    candidates[#candidates + 1] = __root .. "/core/lualib/" .. path
  end
  for _, candidate in ipairs(candidates) do
    local ok, value = run_file(candidate .. ".lua", name)
    if ok then return value end
  end
  -- Sprite layout tables live next to the image assets, which the public data
  -- repository does not ship. Graphics are irrelevant here, so stub them.
  if ("/" .. path):find("/graphics/", 1, true) then
    return { width = 1, height = 1, shift = { 0, 0 }, line_length = 1, frames = 1 }
  end
  -- Main-menu background simulations are not shipped either.
  if path:find("menu-simulations", 1, true) then return {} end
  -- Nor are sound definitions, which are passed straight to data:extend.
  if ("/" .. path):find("/sound/", 1, true) then return { type = "ambient-sound", name = path } end
  error("module not found: " .. name .. " (from mod " .. current_mod .. ")")
end

-- ------------------------------------------------------------------ data stage
local function main()
  current_mod = "core"
  require("dataloader")
  local mod_list = {}
  for m in __mods:gmatch("[^,]+") do mod_list[#mod_list + 1] = m end
  for _, stage in ipairs({ "data", "data-updates", "data-final-fixes" }) do
    for _, m in ipairs(mod_list) do
      current_mod = m
      dir_stack = {}
      run_file(__root .. "/" .. m .. "/" .. stage .. ".lua", stage)
    end
  end
end

local ok, err = xpcall(main, traceback)
if not ok then error(err, 0) end

-- ------------------------------------------------------------------- JSON dump
local SKIP = {
  "graphics", "picture", "animation", "sound", "sprite", "icon", "circuit", "visualisation", "reflection",
  "autoplace", "fluid_box", "collision", "selection", "factoriopedia", "trigger", "light", "smoke", "shadow",
  "localised", "integration", "render", "stripes", "stages", "variations", "particle", "shift", "color",
}
local function skipped(key)
  if type(key) ~= "string" then return false end
  for _, pattern in ipairs(SKIP) do
    if key:find(pattern, 1, true) then return true end
  end
  return false
end

local buf = {}
local function put(s) buf[#buf + 1] = s end
local escapes = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
local function put_string(s)
  put('"')
  put((s:gsub('[%c"\\]', function(c) return escapes[c] or string.format("\\u%04x", c:byte()) end)))
  put('"')
end

local function encode(v, depth)
  local t = type(v)
  if t == "string" then
    put_string(v)
  elseif t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then
      put("null")
    elseif math.type(v) == "integer" then
      put(string.format("%d", v))
    else
      put(string.format("%.14g", v))
    end
  elseif t == "boolean" then
    put(v and "true" or "false")
  elseif t == "table" and depth < 9 and getmetatable(v) == nil then
    local n = #v
    if n > 0 then
      put("[")
      for i = 1, n do
        if i > 1 then put(",") end
        encode(v[i], depth + 1)
      end
      put("]")
    else
      put("{")
      local first = true
      for k, val in pairs(v) do
        local kt = type(k)
        -- depth 0 keys are prototype types and depth 1 keys are prototype names:
        -- only property keys (depth 2+) are filtered
        if (kt == "string" or kt == "number") and not (depth >= 2 and skipped(k)) and type(val) ~= "function" then
          if not first then put(",") end
          first = false
          put_string(tostring(k))
          put(":")
          encode(val, depth + 1)
        end
      end
      put("}")
    end
  else
    put("null")
  end
end

local WANTED = {
  -- item-like prototypes
  "item", "ammo", "capsule", "gun", "item-with-entity-data", "item-with-label", "item-with-inventory",
  "item-with-tags", "module", "rail-planner", "spidertron-remote", "tool", "armor", "repair-tool",
  "space-platform-starter-pack", "selection-tool", "blueprint", "blueprint-book", "copy-paste-tool",
  "deconstruction-item", "upgrade-item",
  -- everything else the calculator reads
  "fluid", "recipe", "recipe-category", "resource", "resource-category", "tile", "plant", "asteroid-chunk",
  "assembling-machine", "furnace", "rocket-silo", "mining-drill", "offshore-pump", "beacon",
  "agricultural-tower", "asteroid-collector", "item-group", "item-subgroup",
}

local out = {}
for _, type_name in ipairs(WANTED) do
  if data.raw[type_name] then out[type_name] = data.raw[type_name] end
end
encode(out, 0)
return table.concat(buf)
