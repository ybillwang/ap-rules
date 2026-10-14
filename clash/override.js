// ============================================================
// ap-rules · Clash 覆写脚本 (JavaScript)
//
// 适用：Clash Verge Rev / Mihomo 核心的「覆写脚本」功能（*.js）
// 功能：与 clash/merge.yaml 完全一致，自动完成
//       1) 注入 rule-providers（ads / ai / cndirect）
//       2) 重建 proxy-groups（系统组 + 自选组，按地区自动分流）
//       3) 重写 rules（广告拦截 / AI / 中国大陆直连 / MATCH）
//
// 相比 Merge(YAML) 的优势：
//       - 节点列表由脚本实时计算，不受订阅 provider 解析顺序影响
//       - 某个地区没有节点时会自动兜底，避免出现空分组导致内核报错
// ============================================================

'use strict';

/* ------------------------------------------------------------
 * 可配置项
 * ---------------------------------------------------------- */

const BASE_URL = 'https://github.com/ybillwang/ap-rules/raw/refs/heads/main/clash/rules';
const FETCH_PROXY = '🇺🇸 美国节点 [系统]'; // 拉取规则集时使用的出口
const PROVIDER_INTERVAL = 86400;

// 健康检查
const HEALTH_CHECK = {
  url: 'https://cp.cloudflare.com/generate_204',
  interval: 300,
  tolerance: 50,
  lazy: true,
};

// 内置的直连 / 拒绝节点，不参与自动分组
const SPECIAL_PROXIES = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'];
const SPECIAL_TYPES = ['Direct', 'Reject', 'RejectDrop', 'Pass', 'Compatible', 'Relay'];

// 排除机场的「官网 / 流量 / 到期」等非节点项
const EXCLUDE_RE =
  /官网|流量|剩余|到期|过期|套餐|订阅|重置|traffic|expire|expired|subscription|reset|official|website/i;

/* ------------------------------------------------------------
 * 地区定义（顺序即分组顺序）
 * ---------------------------------------------------------- */

const REGIONS = [
  { name: '🇭🇰 香港节点 [系统]', re: /🇭🇰|香港|港|\bHK\b|\bHKG\b|Hong[ -]?Kong/i },
  { name: '🇯🇵 日本节点 [系统]', re: /🇯🇵|日本|日|\bJP\b|\bJPN\b|Japan|Tokyo|Osaka/i },
  { name: '🇸🇬 新加坡节点 [系统]', re: /🇸🇬|新加坡|新国|\bSG\b|\bSGP\b|Singapore/i },
  {
    name: '🇺🇸 美国节点 [系统]',
    re: /🇺🇸|美国|美|\bUS\b|\bUSA\b|United[ -]?States|America|Los[ -]?Angeles|New[ -]?York|San[ -]?Francisco/i,
  },
  { name: '🇹🇼 台湾节点 [系统]', re: /🇹🇼|台湾|台|\bTW\b|\bTWN\b|Taiwan|Taipei/i },
];

// 「其他地区」= 不属于上面任一地区的节点
const OTHER_RE = new RegExp(
  '^(?!.*(?:' + REGIONS.map(function (r) { return r.re.source; }).join('|') + ')).*',
  'i'
);

const GROUP_AUTO = '♻️ 自动选择 [系统]';
const GROUP_ALL = '🌐 全部节点 [系统]';
const GROUP_OTHER = '🌍 其他地区 [系统]';
const GROUP_ADS = '🛑 广告拦截 [系统]';
const GROUP_DEFAULT = '🚀 默认代理 [自选]';
const GROUP_AI = '🤖 AI服务 [自选]';

/* ------------------------------------------------------------
 * 工具函数
 * ---------------------------------------------------------- */

function isSpecial(p) {
  return SPECIAL_PROXIES.indexOf(p.name) !== -1 || SPECIAL_TYPES.indexOf(p.type) !== -1;
}

function isExcluded(p) {
  return EXCLUDE_RE.test(p.name);
}

// 取出订阅里的真实节点名称
function collectProxyNames(config) {
  var list = Array.isArray(config.proxies) ? config.proxies : [];
  return list
    .filter(function (p) { return p && p.name && !isSpecial(p) && !isExcluded(p); })
    .map(function (p) { return p.name; });
}

// 订阅是否使用了 proxy-provider（此时无法在脚本里枚举节点，改用 filter 语法）
function hasProxyProvider(config) {
  var providers = config['proxy-providers'];
  return !!providers && Object.keys(providers).length > 0;
}

// 取某地区的节点；为空时兜底为 DIRECT，防止出现空分组
function pickByRegion(names, re) {
  var hit = names.filter(function (n) { return re.test(n); });
  return hit.length > 0 ? hit : ['DIRECT'];
}

/* ------------------------------------------------------------
 * 分组构造
 * ---------------------------------------------------------- */

// 显式列出成员（适用于节点已在 config.proxies 中的订阅）
function selectGroup(name, proxies) {
  return { name: name, type: 'select', proxies: proxies };
}

function urlTestGroup(name, proxies) {
  return {
    name: name,
    type: 'url-test',
    proxies: proxies,
    url: HEALTH_CHECK.url,
    interval: HEALTH_CHECK.interval,
    tolerance: HEALTH_CHECK.tolerance,
    lazy: HEALTH_CHECK.lazy,
  };
}

// 使用 filter 语法通配（适用于 provider 型订阅）
function wildcardSelect(name, filter) {
  var g = {
    name: name,
    type: 'select',
    'include-all-proxies': true,
    'exclude-filter': '(?:' + EXCLUDE_RE.source + ')',
    'exclude-type': 'Direct',
  };
  if (filter) {
    g.filter = filter;
  }
  return g;
}

function wildcardUrlTest(name, filter) {
  var g = wildcardSelect(name, filter);
  g.type = 'url-test';
  g.url = HEALTH_CHECK.url;
  g.interval = HEALTH_CHECK.interval;
  g.tolerance = HEALTH_CHECK.tolerance;
  g.lazy = HEALTH_CHECK.lazy;
  return g;
}

function src(re) {
  return '(?:' + re.source + ')';
}

/* ------------------------------------------------------------
 * Rule Providers
 * ---------------------------------------------------------- */

function buildRuleProviders() {
  var sets = {
    ads: 'ads.yaml',
    ai: 'ai.yaml',
    cndirect: 'cndirect.yaml',
  };
  var out = {};
  Object.keys(sets).forEach(function (key) {
    out[key] = {
      type: 'http',
      behavior: 'classical',
      format: 'yaml',
      interval: PROVIDER_INTERVAL,
      url: BASE_URL + '/' + sets[key],
      path: './ruleset/' + sets[key],
      proxy: FETCH_PROXY,
    };
  });
  return out;
}

/* ------------------------------------------------------------
 * Proxy Groups
 * ---------------------------------------------------------- */

function buildProxyGroups(config) {
  var names = collectProxyNames(config);
  var wildcard = names.length === 0 && hasProxyProvider(config);

  var groups = [];

  // ---------- 用户自选组 ----------
  var regionNames = REGIONS.map(function (r) { return r.name; });
  groups.push(
    selectGroup(GROUP_DEFAULT, [GROUP_AUTO].concat(regionNames, [GROUP_OTHER, GROUP_ALL]))
  );
  groups.push(
    selectGroup(
      GROUP_AI,
      [
        '🇺🇸 美国节点 [系统]',
        '🇯🇵 日本节点 [系统]',
        '🇸🇬 新加坡节点 [系统]',
        '🇭🇰 香港节点 [系统]',
        '🇹🇼 台湾节点 [系统]',
        GROUP_OTHER,
        GROUP_ALL,
        'DIRECT',
      ]
    )
  );

  // ---------- 系统组 ----------
  if (wildcard) {
    groups.push(wildcardSelect(GROUP_ALL, undefined));
    groups.push(wildcardUrlTest(GROUP_AUTO, undefined));
  } else {
    groups.push(selectGroup(GROUP_ALL, names.length > 0 ? names : ['DIRECT']));
    groups.push(urlTestGroup(GROUP_AUTO, names.length > 0 ? names : ['DIRECT']));
  }

  // ---------- 地区节点 ----------
  REGIONS.forEach(function (r) {
    if (wildcard) {
      groups.push(wildcardUrlTest(r.name, src(r.re)));
    } else {
      groups.push(urlTestGroup(r.name, pickByRegion(names, r.re)));
    }
  });

  // ---------- 其他地区 ----------
  if (wildcard) {
    groups.push(wildcardSelect(GROUP_OTHER, OTHER_RE.source));
  } else {
    groups.push(selectGroup(GROUP_OTHER, pickByRegion(names, OTHER_RE)));
  }

  // ---------- 广告拦截 ----------
  groups.push(selectGroup(GROUP_ADS, ['REJECT', 'DIRECT']));

  return groups;
}

/* ------------------------------------------------------------
 * Rules
 * ---------------------------------------------------------- */

function buildRules() {
  return [
    // fallback dns
    'IP-CIDR,1.1.1.1/32,' + GROUP_DEFAULT + ',no-resolve',
    'IP-CIDR,8.8.8.8/32,' + GROUP_DEFAULT + ',no-resolve',

    // 自定义中国直连
    'RULE-SET,cndirect,DIRECT',

    // 私有地址 / 局域网
    'GEOSITE,private,DIRECT',
    'GEOIP,private,DIRECT,no-resolve',

    // 广告
    'RULE-SET,ads,' + GROUP_ADS,

    // AI
    'RULE-SET,ai,' + GROUP_AI,

    // 中国大陆
    'GEOSITE,CN,DIRECT',
    'GEOIP,CN,DIRECT,no-resolve',

    // 其他流量
    'MATCH,' + GROUP_DEFAULT,
  ];
}

/* ------------------------------------------------------------
 * 入口
 * ---------------------------------------------------------- */

function main(config, profileName) {
  config = config || {};

  config['rule-providers'] = buildRuleProviders();
  config['proxy-groups'] = buildProxyGroups(config);
  config['rules'] = buildRules();

  return config;
}
