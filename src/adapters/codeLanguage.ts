/**
 * ★ 代码语言包按需加载（扩展名 → CM6 LanguageSupport）。
 * 所有 import 必须动态：语言包（含 legacy-modes）不得进首屏 chunk（架构 D4）。
 * 扩展名集合与 Rust 侧 fs_service::TEXT_EXTS 的代码集对齐（见下方 loaders + 该常量）。
 *
 * 类型说明：@codemirror/legacy-modes 的 StreamParser 源自 @codemirror/streamparser，
 * 与 @codemirror/language 内置 StringStream 的私有 tabSize 声明存在**名义类型**差异
 * （运行时为同一结构，扁平安装下版本交叉所致），经 defineLegacy 统一断言收口。
 *
 * 导出名注意：legacy-modes 多数模块导出名 === 文件名，少数例外（已实测 .d.ts）：
 *   powershell → powerShell | coffeescript → coffeeScript | commonlisp → commonLisp |
 *   dockerfile → dockerFile | clike → {c,cpp,java,csharp,scala,kotlin,dart,objectiveC,...} |
 *   mllike → {oCaml,fSharp,sml} | sql → {standardSQL,mySQL,pgSQL,sqlite,msSQL,...} |
 *   stex → {stex,stexMath} | vbscript → {vbScript,vbScriptASP} | webidl → webIDL |
 *   xquery → xQuery | ttcn-cfg → ttcnCfg | haxe → {haxe,hxml} | gas → {gas,gasArm}
 */
import { StreamLanguage } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

type LangLoader = () => Promise<Extension[]>;

/** legacy StreamParser 断言收口：streamparser 名义类型 → language 运行时类型 */
function defineLegacy(parser: unknown) {
  return StreamLanguage.define(parser as Parameters<typeof StreamLanguage.define>[0]);
}

/**
 * legacy 语言加载器（查表）：按 (模块名, 导出名) 取下方字面量动态 import。
 * ★ 必须逐模块字面量 import——bare specifier 的模板字符串动态 import 在浏览器运行时
 *   无法解析（WebView 不认裸模块名），Vite 亦无法静态分析（dynamic-import-vars 限制），
 *   会导致全部 legacy 语言静默失败退回纯文本（2026-10-09 实测踩坑：.sh/.conf 等无着色）。
 *   字面量 import 可被 Vite 静态析出 → dev 预构建 + build 按 chunk 分包，懒加载语义不变。
 */
function legacy(mod: string, name: string): LangLoader {
  return legacyLoaders[`${mod}:${name}`] ?? (async () => []);
}

// ── legacy 模块字面量加载器（104 个去重模块；由 gen 脚本生成，手工增改见上表注释）──
const L_javascript_jsonld: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/javascript')) as Record<string, unknown>).jsonld)];
const L_xml_xml: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/xml')) as Record<string, unknown>).xml)];
const L_stylus_stylus: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/stylus')) as Record<string, unknown>).stylus)];
const L_sql_mySQL: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/sql')) as Record<string, unknown>).mySQL)];
const L_sql_pgSQL: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/sql')) as Record<string, unknown>).pgSQL)];
const L_sql_sqlite: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/sql')) as Record<string, unknown>).sqlite)];
const L_sql_msSQL: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/sql')) as Record<string, unknown>).msSQL)];
const L_sql_mariaDB: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/sql')) as Record<string, unknown>).mariaDB)];
const L_sql_plSQL: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/sql')) as Record<string, unknown>).plSQL)];
const L_sql_hive: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/sql')) as Record<string, unknown>).hive)];
const L_sql_sparkSQL: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/sql')) as Record<string, unknown>).sparkSQL)];
const L_clike_csharp: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/clike')) as Record<string, unknown>).csharp)];
const L_clike_scala: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/clike')) as Record<string, unknown>).scala)];
const L_clike_kotlin: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/clike')) as Record<string, unknown>).kotlin)];
const L_clike_dart: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/clike')) as Record<string, unknown>).dart)];
const L_toml_toml: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/toml')) as Record<string, unknown>).toml)];
const L_properties_properties: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/properties')) as Record<string, unknown>).properties)];
const L_diff_diff: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/diff')) as Record<string, unknown>).diff)];
const L_dockerfile_dockerFile: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/dockerfile')) as Record<string, unknown>).dockerFile)];
const L_cmake_cmake: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/cmake')) as Record<string, unknown>).cmake)];
const L_go_go: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/go')) as Record<string, unknown>).go)];
const L_ruby_ruby: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/ruby')) as Record<string, unknown>).ruby)];
const L_shell_shell: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/shell')) as Record<string, unknown>).shell)];
const L_powershell_powerShell: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/powershell')) as Record<string, unknown>).powerShell)];
const L_lua_lua: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/lua')) as Record<string, unknown>).lua)];
const L_perl_perl: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/perl')) as Record<string, unknown>).perl)];
const L_r_r: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/r')) as Record<string, unknown>).r)];
const L_swift_swift: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/swift')) as Record<string, unknown>).swift)];
const L_clojure_clojure: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/clojure')) as Record<string, unknown>).clojure)];
const L_haskell_haskell: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/haskell')) as Record<string, unknown>).haskell)];
const L_elm_elm: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/elm')) as Record<string, unknown>).elm)];
const L_erlang_erlang: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/erlang')) as Record<string, unknown>).erlang)];
const L_commonlisp_commonLisp: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/commonlisp')) as Record<string, unknown>).commonLisp)];
const L_scheme_scheme: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/scheme')) as Record<string, unknown>).scheme)];
const L_mllike_oCaml: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/mllike')) as Record<string, unknown>).oCaml)];
const L_mllike_fSharp: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/mllike')) as Record<string, unknown>).fSharp)];
const L_mllike_sml: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/mllike')) as Record<string, unknown>).sml)];
const L_pascal_pascal: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/pascal')) as Record<string, unknown>).pascal)];
const L_d_d: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/d')) as Record<string, unknown>).d)];
const L_fortran_fortran: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/fortran')) as Record<string, unknown>).fortran)];
const L_verilog_verilog: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/verilog')) as Record<string, unknown>).verilog)];
const L_vhdl_vhdl: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/vhdl')) as Record<string, unknown>).vhdl)];
const L_gas_gas: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/gas')) as Record<string, unknown>).gas)];
const L_cobol_cobol: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/cobol')) as Record<string, unknown>).cobol)];
const L_crystal_crystal: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/crystal')) as Record<string, unknown>).crystal)];
const L_groovy_groovy: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/groovy')) as Record<string, unknown>).groovy)];
const L_julia_julia: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/julia')) as Record<string, unknown>).julia)];
const L_coffeescript_coffeeScript: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/coffeescript')) as Record<string, unknown>).coffeeScript)];
const L_stex_stex: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/stex')) as Record<string, unknown>).stex)];
const L_tcl_tcl: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/tcl')) as Record<string, unknown>).tcl)];
const L_gherkin_gherkin: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/gherkin')) as Record<string, unknown>).gherkin)];
const L_protobuf_protobuf: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/protobuf')) as Record<string, unknown>).protobuf)];
const L_solr_solr: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/solr')) as Record<string, unknown>).solr)];
const L_sparql_sparql: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/sparql')) as Record<string, unknown>).sparql)];
const L_turtle_turtle: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/turtle')) as Record<string, unknown>).turtle)];
const L_ntriples_ntriples: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/ntriples')) as Record<string, unknown>).ntriples)];
const L_mscgen_mscgen: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/mscgen')) as Record<string, unknown>).mscgen)];
const L_webidl_webIDL: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/webidl')) as Record<string, unknown>).webIDL)];
const L_idl_idl: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/idl')) as Record<string, unknown>).idl)];
const L_xquery_xQuery: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/xquery')) as Record<string, unknown>).xQuery)];
const L_nsis_nsis: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/nsis')) as Record<string, unknown>).nsis)];
const L_puppet_puppet: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/puppet')) as Record<string, unknown>).puppet)];
const L_vb_vb: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/vb')) as Record<string, unknown>).vb)];
const L_vbscript_vbScript: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/vbscript')) as Record<string, unknown>).vbScript)];
const L_velocity_velocity: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/velocity')) as Record<string, unknown>).velocity)];
const L_nginx_nginx: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/nginx')) as Record<string, unknown>).nginx)];
const L_rpm_rpmChanges: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/rpm')) as Record<string, unknown>).rpmChanges)];
const L_rpm_rpmSpec: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/rpm')) as Record<string, unknown>).rpmSpec)];
const L_oz_oz: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/oz')) as Record<string, unknown>).oz)];
const L_pig_pig: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/pig')) as Record<string, unknown>).pig)];
const L_pegjs_pegjs: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/pegjs')) as Record<string, unknown>).pegjs)];
const L_sas_sas: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/sas')) as Record<string, unknown>).sas)];
const L_factor_factor: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/factor')) as Record<string, unknown>).factor)];
const L_fcl_fcl: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/fcl')) as Record<string, unknown>).fcl)];
const L_forth_forth: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/forth')) as Record<string, unknown>).forth)];
const L_dylan_dylan: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/dylan')) as Record<string, unknown>).dylan)];
const L_ebnf_ebnf: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/ebnf')) as Record<string, unknown>).ebnf)];
const L_ecl_ecl: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/ecl')) as Record<string, unknown>).ecl)];
const L_eiffel_eiffel: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/eiffel')) as Record<string, unknown>).eiffel)];
const L_haxe_haxe: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/haxe')) as Record<string, unknown>).haxe)];
const L_haxe_hxml: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/haxe')) as Record<string, unknown>).hxml)];
const L_http_http: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/http')) as Record<string, unknown>).http)];
const L_livescript_liveScript: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/livescript')) as Record<string, unknown>).liveScript)];
const L_mathematica_mathematica: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/mathematica')) as Record<string, unknown>).mathematica)];
const L_mbox_mbox: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/mbox')) as Record<string, unknown>).mbox)];
const L_mirc_mirc: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/mirc')) as Record<string, unknown>).mirc)];
const L_modelica_modelica: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/modelica')) as Record<string, unknown>).modelica)];
const L_octave_octave: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/octave')) as Record<string, unknown>).octave)];
const L_smalltalk_smalltalk: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/smalltalk')) as Record<string, unknown>).smalltalk)];
const L_sieve_sieve: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/sieve')) as Record<string, unknown>).sieve)];
const L_textile_textile: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/textile')) as Record<string, unknown>).textile)];
const L_tiddlywiki_tiddlyWiki: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/tiddlywiki')) as Record<string, unknown>).tiddlyWiki)];
const L_tiki_tiki: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/tiki')) as Record<string, unknown>).tiki)];
const L_troff_troff: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/troff')) as Record<string, unknown>).troff)];
const L_ttcn_ttcn: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/ttcn')) as Record<string, unknown>).ttcn)];
const L_ttcn_cfg_ttcnCfg: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/ttcn-cfg')) as Record<string, unknown>).ttcnCfg)];
const L_wast_wast: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/wast')) as Record<string, unknown>).wast)];
const L_yacas_yacas: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/yacas')) as Record<string, unknown>).yacas)];
const L_apl_apl: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/apl')) as Record<string, unknown>).apl)];
const L_asciiarmor_asciiArmor: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/asciiarmor')) as Record<string, unknown>).asciiArmor)];
const L_asterisk_asterisk: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/asterisk')) as Record<string, unknown>).asterisk)];
const L_brainfuck_brainfuck: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/brainfuck')) as Record<string, unknown>).brainfuck)];
const L_cypher_cypher: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/cypher')) as Record<string, unknown>).cypher)];
const L_dtd_dtd: LangLoader = async () => [defineLegacy(((await import('@codemirror/legacy-modes/mode/dtd')) as Record<string, unknown>).dtd)];

const legacyLoaders: Record<string, LangLoader> = {
  'javascript:jsonld': L_javascript_jsonld,
  'xml:xml': L_xml_xml,
  'stylus:stylus': L_stylus_stylus,
  'sql:mySQL': L_sql_mySQL,
  'sql:pgSQL': L_sql_pgSQL,
  'sql:sqlite': L_sql_sqlite,
  'sql:msSQL': L_sql_msSQL,
  'sql:mariaDB': L_sql_mariaDB,
  'sql:plSQL': L_sql_plSQL,
  'sql:hive': L_sql_hive,
  'sql:sparkSQL': L_sql_sparkSQL,
  'clike:csharp': L_clike_csharp,
  'clike:scala': L_clike_scala,
  'clike:kotlin': L_clike_kotlin,
  'clike:dart': L_clike_dart,
  'toml:toml': L_toml_toml,
  'properties:properties': L_properties_properties,
  'diff:diff': L_diff_diff,
  'dockerfile:dockerFile': L_dockerfile_dockerFile,
  'cmake:cmake': L_cmake_cmake,
  'go:go': L_go_go,
  'ruby:ruby': L_ruby_ruby,
  'shell:shell': L_shell_shell,
  'powershell:powerShell': L_powershell_powerShell,
  'lua:lua': L_lua_lua,
  'perl:perl': L_perl_perl,
  'r:r': L_r_r,
  'swift:swift': L_swift_swift,
  'clojure:clojure': L_clojure_clojure,
  'haskell:haskell': L_haskell_haskell,
  'elm:elm': L_elm_elm,
  'erlang:erlang': L_erlang_erlang,
  'commonlisp:commonLisp': L_commonlisp_commonLisp,
  'scheme:scheme': L_scheme_scheme,
  'mllike:oCaml': L_mllike_oCaml,
  'mllike:fSharp': L_mllike_fSharp,
  'mllike:sml': L_mllike_sml,
  'pascal:pascal': L_pascal_pascal,
  'd:d': L_d_d,
  'fortran:fortran': L_fortran_fortran,
  'verilog:verilog': L_verilog_verilog,
  'vhdl:vhdl': L_vhdl_vhdl,
  'gas:gas': L_gas_gas,
  'cobol:cobol': L_cobol_cobol,
  'crystal:crystal': L_crystal_crystal,
  'groovy:groovy': L_groovy_groovy,
  'julia:julia': L_julia_julia,
  'coffeescript:coffeeScript': L_coffeescript_coffeeScript,
  'stex:stex': L_stex_stex,
  'tcl:tcl': L_tcl_tcl,
  'gherkin:gherkin': L_gherkin_gherkin,
  'protobuf:protobuf': L_protobuf_protobuf,
  'solr:solr': L_solr_solr,
  'sparql:sparql': L_sparql_sparql,
  'turtle:turtle': L_turtle_turtle,
  'ntriples:ntriples': L_ntriples_ntriples,
  'mscgen:mscgen': L_mscgen_mscgen,
  'webidl:webIDL': L_webidl_webIDL,
  'idl:idl': L_idl_idl,
  'xquery:xQuery': L_xquery_xQuery,
  'nsis:nsis': L_nsis_nsis,
  'puppet:puppet': L_puppet_puppet,
  'vb:vb': L_vb_vb,
  'vbscript:vbScript': L_vbscript_vbScript,
  'velocity:velocity': L_velocity_velocity,
  'nginx:nginx': L_nginx_nginx,
  'rpm:rpmChanges': L_rpm_rpmChanges,
  'rpm:rpmSpec': L_rpm_rpmSpec,
  'oz:oz': L_oz_oz,
  'pig:pig': L_pig_pig,
  'pegjs:pegjs': L_pegjs_pegjs,
  'sas:sas': L_sas_sas,
  'factor:factor': L_factor_factor,
  'fcl:fcl': L_fcl_fcl,
  'forth:forth': L_forth_forth,
  'dylan:dylan': L_dylan_dylan,
  'ebnf:ebnf': L_ebnf_ebnf,
  'ecl:ecl': L_ecl_ecl,
  'eiffel:eiffel': L_eiffel_eiffel,
  'haxe:haxe': L_haxe_haxe,
  'haxe:hxml': L_haxe_hxml,
  'http:http': L_http_http,
  'livescript:liveScript': L_livescript_liveScript,
  'mathematica:mathematica': L_mathematica_mathematica,
  'mbox:mbox': L_mbox_mbox,
  'mirc:mirc': L_mirc_mirc,
  'modelica:modelica': L_modelica_modelica,
  'octave:octave': L_octave_octave,
  'smalltalk:smalltalk': L_smalltalk_smalltalk,
  'sieve:sieve': L_sieve_sieve,
  'textile:textile': L_textile_textile,
  'tiddlywiki:tiddlyWiki': L_tiddlywiki_tiddlyWiki,
  'tiki:tiki': L_tiki_tiki,
  'troff:troff': L_troff_troff,
  'ttcn:ttcn': L_ttcn_ttcn,
  'ttcn-cfg:ttcnCfg': L_ttcn_cfg_ttcnCfg,
  'wast:wast': L_wast_wast,
  'yacas:yacas': L_yacas_yacas,
  'apl:apl': L_apl_apl,
  'asciiarmor:asciiArmor': L_asciiarmor_asciiArmor,
  'asterisk:asterisk': L_asterisk_asterisk,
  'brainfuck:brainfuck': L_brainfuck_brainfuck,
  'cypher:cypher': L_cypher_cypher,
  'dtd:dtd': L_dtd_dtd,
};

// ── 官方语言包（优先于 legacy，动态 import 懒加载）──
const jsLoader = async () => [(await import('@codemirror/lang-javascript')).javascript({ jsx: true })];
const tsLoader = async () => [(await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true })];
const mtsLoader = async () => [(await import('@codemirror/lang-javascript')).javascript({ typescript: true })];
const jsonLoader = async () => [(await import('@codemirror/lang-json')).json()];
const htmlLoader = async () => [(await import('@codemirror/lang-html')).html()];
const cssLoader = async () => [(await import('@codemirror/lang-css')).css()];
const pythonLoader = async () => [(await import('@codemirror/lang-python')).python()];
const rustLoader = async () => [(await import('@codemirror/lang-rust')).rust()];
const javaLoader = async () => [(await import('@codemirror/lang-java')).java()];
const sqlLoader = async () => [(await import('@codemirror/lang-sql')).sql()];
const yamlLoader = async () => [(await import('@codemirror/lang-yaml')).yaml()];
const cppLoader = async () => [(await import('@codemirror/lang-cpp')).cpp()];

const loaders: Record<string, LangLoader> = {
  // ══ JavaScript / TypeScript ══
  js: jsLoader, mjs: jsLoader, cjs: jsLoader, jsx: jsLoader, es6: jsLoader, pac: jsLoader,
  ts: tsLoader, tsx: tsLoader, mts: mtsLoader, cts: mtsLoader,

  // ══ JSON / 数据交换 ══
  json: jsonLoader, jsonc: jsonLoader, json5: jsonLoader,
  ndjson: jsonLoader, geojson: jsonLoader, jsonld: legacy('javascript', 'jsonld'),

  // ══ Web 标记 / 模板 ══
  html: htmlLoader, htm: htmlLoader, xhtml: htmlLoader,
  vue: htmlLoader, svelte: htmlLoader,
  jsp: htmlLoader, jspx: htmlLoader, erb: htmlLoader,
  ejs: htmlLoader, hbs: htmlLoader, mustache: htmlLoader,
  xml: legacy('xml', 'xml'), xsd: legacy('xml', 'xml'), xsl: legacy('xml', 'xml'),
  svg: legacy('xml', 'xml'),
  rss: legacy('xml', 'xml'), atom: legacy('xml', 'xml'),
  wsdl: legacy('xml', 'xml'), plist: legacy('xml', 'xml'),

  // ══ CSS / 样式 ══
  css: cssLoader, scss: cssLoader, less: cssLoader, sass: cssLoader, pcss: cssLoader,
  styl: legacy('stylus', 'stylus'),

  // ══ 后端 / 脚本（官方包）══
  py: pythonLoader, pyw: pythonLoader, pyi: pythonLoader, pyx: pythonLoader,
  rs: rustLoader, java: javaLoader,
  yaml: yamlLoader, yml: yamlLoader,

  // ══ SQL 方言 ══
  sql: sqlLoader,
  mysql: legacy('sql', 'mySQL'), pgsql: legacy('sql', 'pgSQL'),
  postgres: legacy('sql', 'pgSQL'), sqlite: legacy('sql', 'sqlite'),
  mssql: legacy('sql', 'msSQL'), mariadb: legacy('sql', 'mariaDB'),
  oracle: legacy('sql', 'plSQL'), hive: legacy('sql', 'hive'), spark: legacy('sql', 'sparkSQL'),

  // ══ C / C++ 系（官方 cpp 包）══
  c: cppLoader, h: cppLoader, cpp: cppLoader, hpp: cppLoader, cc: cppLoader,
  cxx: cppLoader, hxx: cppLoader, hh: cppLoader, 'c++': cppLoader, 'h++': cppLoader,
  ino: cppLoader, ipp: cppLoader, tpp: cppLoader,

  // ══ C# / Scala / Kotlin / Dart（clike 模块，legacy）══
  cs: legacy('clike', 'csharp'), scala: legacy('clike', 'scala'),
  kotlin: legacy('clike', 'kotlin'), kt: legacy('clike', 'kotlin'),
  dart: legacy('clike', 'dart'),

  // ══ 配置 / 标记语言 ══
  toml: legacy('toml', 'toml'),
  ini: legacy('properties', 'properties'), cfg: legacy('properties', 'properties'),
  conf: legacy('properties', 'properties'), properties: legacy('properties', 'properties'),
  env: legacy('properties', 'properties'), config: legacy('properties', 'properties'),
  cnf: legacy('properties', 'properties'), inf: legacy('properties', 'properties'),
  // systemd unit（.service/.timer/.socket/.target/.mount）与 .desktop 入口：同为 ini 风格键值
  service: legacy('properties', 'properties'), timer: legacy('properties', 'properties'),
  socket: legacy('properties', 'properties'), target: legacy('properties', 'properties'),
  mount: legacy('properties', 'properties'), desktop: legacy('properties', 'properties'),
  diff: legacy('diff', 'diff'), patch: legacy('diff', 'diff'),
  dockerfile: legacy('dockerfile', 'dockerFile'), containerfile: legacy('dockerfile', 'dockerFile'),
  cmake: legacy('cmake', 'cmake'),

  // ══ 各语言（legacy-modes）══
  go: legacy('go', 'go'),
  rb: legacy('ruby', 'ruby'), rake: legacy('ruby', 'ruby'),
  gemspec: legacy('ruby', 'ruby'), ru: legacy('ruby', 'ruby'),
  sh: legacy('shell', 'shell'), bash: legacy('shell', 'shell'),
  zsh: legacy('shell', 'shell'), ksh: legacy('shell', 'shell'),
  bat: legacy('powershell', 'powerShell'), ps1: legacy('powershell', 'powerShell'),
  pwsh: legacy('powershell', 'powerShell'),
  lua: legacy('lua', 'lua'), luau: legacy('lua', 'lua'), nse: legacy('lua', 'lua'),
  pl: legacy('perl', 'perl'), pm: legacy('perl', 'perl'), perl: legacy('perl', 'perl'),
  r: legacy('r', 'r'),
  swift: legacy('swift', 'swift'),
  clj: legacy('clojure', 'clojure'), cljs: legacy('clojure', 'clojure'),
  cljc: legacy('clojure', 'clojure'), edn: legacy('clojure', 'clojure'),
  hs: legacy('haskell', 'haskell'), lhs: legacy('haskell', 'haskell'),
  elm: legacy('elm', 'elm'),
  erl: legacy('erlang', 'erlang'), hrl: legacy('erlang', 'erlang'),
  lisp: legacy('commonlisp', 'commonLisp'), cl: legacy('commonlisp', 'commonLisp'),
  lsp: legacy('commonlisp', 'commonLisp'), el: legacy('commonlisp', 'commonLisp'),
  scm: legacy('scheme', 'scheme'), ss: legacy('scheme', 'scheme'),
  ocaml: legacy('mllike', 'oCaml'), ml: legacy('mllike', 'oCaml'),
  fs: legacy('mllike', 'fSharp'), fsharp: legacy('mllike', 'fSharp'),
  sml: legacy('mllike', 'sml'),
  pas: legacy('pascal', 'pascal'), pp: legacy('pascal', 'pascal'),
  p: legacy('pascal', 'pascal'), lpr: legacy('pascal', 'pascal'), dpr: legacy('pascal', 'pascal'),
  d: legacy('d', 'd'),
  f: legacy('fortran', 'fortran'), for: legacy('fortran', 'fortran'),
  f77: legacy('fortran', 'fortran'), f90: legacy('fortran', 'fortran'),
  f95: legacy('fortran', 'fortran'), f03: legacy('fortran', 'fortran'),
  f08: legacy('fortran', 'fortran'), fpp: legacy('fortran', 'fortran'), ftn: legacy('fortran', 'fortran'),
  v: legacy('verilog', 'verilog'), sv: legacy('verilog', 'verilog'), svh: legacy('verilog', 'verilog'),
  vhd: legacy('vhdl', 'vhdl'), vhdl: legacy('vhdl', 'vhdl'),
  asm: legacy('gas', 'gas'), s: legacy('gas', 'gas'), nasm: legacy('gas', 'gas'),
  cob: legacy('cobol', 'cobol'), cbl: legacy('cobol', 'cobol'), cobol: legacy('cobol', 'cobol'),
  cr: legacy('crystal', 'crystal'),
  groovy: legacy('groovy', 'groovy'), gradle: legacy('groovy', 'groovy'), gvy: legacy('groovy', 'groovy'),
  julia: legacy('julia', 'julia'), jl: legacy('julia', 'julia'),
  coffeescript: legacy('coffeescript', 'coffeeScript'), coffee: legacy('coffeescript', 'coffeeScript'),
  iced: legacy('coffeescript', 'coffeeScript'),
  tex: legacy('stex', 'stex'), sty: legacy('stex', 'stex'), cls: legacy('stex', 'stex'),
  bib: legacy('stex', 'stex'), stex: legacy('stex', 'stex'),
  tcl: legacy('tcl', 'tcl'), tclsh: legacy('tcl', 'tcl'),

  // ══ 标记 / 查询 / 文档 ══
  feature: legacy('gherkin', 'gherkin'),
  proto: legacy('protobuf', 'protobuf'),
  solr: legacy('solr', 'solr'),
  sparql: legacy('sparql', 'sparql'), rq: legacy('sparql', 'sparql'),
  ttl: legacy('turtle', 'turtle'),
  nt: legacy('ntriples', 'ntriples'),
  msc: legacy('mscgen', 'mscgen'),
  widl: legacy('webidl', 'webIDL'), webidl: legacy('webidl', 'webIDL'),
  idl: legacy('idl', 'idl'),
  xq: legacy('xquery', 'xQuery'), xql: legacy('xquery', 'xQuery'),
  xquery: legacy('xquery', 'xQuery'), xqy: legacy('xquery', 'xQuery'), xqm: legacy('xquery', 'xQuery'),

  // ══ 构建 / 运维 / DSL ══
  nsi: legacy('nsis', 'nsis'), nsh: legacy('nsis', 'nsis'),
  puppet: legacy('puppet', 'puppet'),
  vb: legacy('vb', 'vb'), vbs: legacy('vbscript', 'vbScript'),
  vm: legacy('velocity', 'velocity'),
  nginx: legacy('nginx', 'nginx'),
  rpm: legacy('rpm', 'rpmChanges'), spec: legacy('rpm', 'rpmSpec'),
  oz: legacy('oz', 'oz'),
  pig: legacy('pig', 'pig'),
  pegjs: legacy('pegjs', 'pegjs'), peg: legacy('pegjs', 'pegjs'),
  sas: legacy('sas', 'sas'),

  // ══ 函数式 / 学术 / 小众（legacy）══
  factor: legacy('factor', 'factor'),
  fcl: legacy('fcl', 'fcl'),
  forth: legacy('forth', 'forth'), frt: legacy('forth', 'forth'),
  dylan: legacy('dylan', 'dylan'), dyl: legacy('dylan', 'dylan'),
  ebnf: legacy('ebnf', 'ebnf'),
  ecl: legacy('ecl', 'ecl'),
  eiffel: legacy('eiffel', 'eiffel'), e: legacy('eiffel', 'eiffel'),
  haxe: legacy('haxe', 'haxe'), hxml: legacy('haxe', 'hxml'),
  http: legacy('http', 'http'),
  jinja: legacy('jinja2', 'jinja2'), j2: legacy('jinja2', 'jinja2'), jinja2: legacy('jinja2', 'jinja2'),
  livescript: legacy('livescript', 'liveScript'), ls: legacy('livescript', 'liveScript'),
  mathematica: legacy('mathematica', 'mathematica'), mma: legacy('mathematica', 'mathematica'),
  mbox: legacy('mbox', 'mbox'),
  mirc: legacy('mirc', 'mirc'), mrc: legacy('mirc', 'mirc'),
  modelica: legacy('modelica', 'modelica'), mo: legacy('modelica', 'modelica'),
  octave: legacy('octave', 'octave'),
  smalltalk: legacy('smalltalk', 'smalltalk'), st: legacy('smalltalk', 'smalltalk'),
  sieve: legacy('sieve', 'sieve'), siv: legacy('sieve', 'sieve'),
  textile: legacy('textile', 'textile'),
  tiddlywiki: legacy('tiddlywiki', 'tiddlyWiki'), tid: legacy('tiddlywiki', 'tiddlyWiki'),
  tiki: legacy('tiki', 'tiki'),
  troff: legacy('troff', 'troff'), roff: legacy('troff', 'troff'),
  ttcn: legacy('ttcn', 'ttcn'), ttcn3: legacy('ttcn', 'ttcn'), ttcnpp: legacy('ttcn-cfg', 'ttcnCfg'),
  wast: legacy('wast', 'wast'), wat: legacy('wast', 'wast'),
  yacas: legacy('yacas', 'yacas'),
  z80: legacy('z80', 'z80'),

  // ══ 编码 / 协议 / 杂项（legacy）══
  apl: legacy('apl', 'apl'),
  asn: legacy('asn1', 'asn1'), asn1: legacy('asn1', 'asn1'),
  asc: legacy('asciiarmor', 'asciiArmor'),
  asterisk: legacy('asterisk', 'asterisk'),
  brainfuck: legacy('brainfuck', 'brainfuck'), bf: legacy('brainfuck', 'brainfuck'),
  cypher: legacy('cypher', 'cypher'), cql: legacy('cypher', 'cypher'),
  dtd: legacy('dtd', 'dtd'),
};

/** 取扩展名对应的语言扩展；无映射或加载失败返回空数组（纯文本兜底） */
export async function buildLanguageExtensions(ext: string): Promise<Extension[]> {
  const loader = loaders[ext.toLowerCase()];
  if (!loader) return [];
  try {
    return await loader();
  } catch (err) {
    console.warn(`[codeLanguage] 语言包加载失败: .${ext}`, err);
    return [];
  }
}
