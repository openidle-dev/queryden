import { Server, Database, Search } from "lucide-react";
import { 
  SiPostgresql, 
  SiMysql, 
  SiSqlite, 
  SiMongodb, 
  SiRedis, 
  SiSupabase, 
  SiSnowflake, 
  SiFirebase, 
  SiNeo4J, 
  SiCouchbase, 
  SiInfluxdb, 
  SiApachecassandra,
  SiSinglestore,
  SiDuckdb
} from "react-icons/si";
import { GrOracle } from "react-icons/gr";

export interface DatabaseProvider {
  id: string;
  name: string;
  icon: any; 
  color: string;
  bg: string;
  type: string;
  defaultPort?: string;
  comingSoon?: boolean;
}

export const PROVIDERS: DatabaseProvider[] = [
  // --- PostgreSQL Wire Protocol Compatible (WORKING) ---
  { id: "postgres", name: "PostgreSQL", icon: SiPostgresql, color: "text-blue-400", bg: "bg-blue-400/10", type: "RDBMS", defaultPort: "5432" },
  { id: "supabase", name: "Supabase", icon: SiSupabase, color: "text-emerald-400", bg: "bg-emerald-400/10", type: "Cloud", defaultPort: "5432" },
  { id: "cockroach", name: "CockroachDB", icon: Database, color: "text-green-600", bg: "bg-green-600/10", type: "Cloud", defaultPort: "26257" },
  { id: "redshift", name: "Amazon Redshift", icon: Database, color: "text-orange-500", bg: "bg-orange-500/10", type: "Cloud", defaultPort: "5439" },
  { id: "timescale", name: "TimescaleDB", icon: Database, color: "text-amber-500", bg: "bg-amber-500/10", type: "Time-Series", defaultPort: "5432" },
  { id: "yugabyte", name: "YugabyteDB", icon: Database, color: "text-orange-600", bg: "bg-orange-600/10", type: "Cloud", defaultPort: "5433" },
  { id: "neon", name: "Neon", icon: Database, color: "text-emerald-500", bg: "bg-emerald-500/10", type: "Cloud", defaultPort: "5432" },
  { id: "citus", name: "Citus", icon: Server, color: "text-blue-500", bg: "bg-blue-500/10", type: "Cloud", defaultPort: "5432" },
  { id: "materialize", name: "Materialize", icon: Server, color: "text-purple-400", bg: "bg-purple-400/10", type: "Streaming", defaultPort: "6875" },
  { id: "questdb", name: "QuestDB", icon: Database, color: "text-red-500", bg: "bg-red-500/10", type: "Time-Series", defaultPort: "8812" },
  { id: "greenplum", name: "Greenplum", icon: Database, color: "text-green-500", bg: "bg-green-500/10", type: "Data Warehouse", defaultPort: "5432" },
  { id: "alloydb", name: "Google AlloyDB", icon: Database, color: "text-blue-400", bg: "bg-blue-400/10", type: "Cloud", defaultPort: "5432" },

  // --- MySQL Wire Protocol Compatible (WORKING) ---
  { id: "mysql", name: "MySQL", icon: SiMysql, color: "text-orange-400", bg: "bg-orange-400/10", type: "RDBMS", defaultPort: "3306" },
  { id: "mariadb", name: "MariaDB", icon: SiMysql, color: "text-blue-500", bg: "bg-blue-500/10", type: "RDBMS", defaultPort: "3306" },
  { id: "tidb", name: "TiDB", icon: Server, color: "text-indigo-400", bg: "bg-indigo-400/10", type: "NewSQL", defaultPort: "4000" },
  { id: "singlestore", name: "SingleStore", icon: SiSinglestore, color: "text-purple-500", bg: "bg-purple-500/10", type: "NewSQL", defaultPort: "3306" },
  { id: "oceanbase", name: "OceanBase", icon: Database, color: "text-blue-600", bg: "bg-blue-600/10", type: "NewSQL", defaultPort: "2881" },
  { id: "percona", name: "Percona", icon: Database, color: "text-orange-600", bg: "bg-orange-600/10", type: "RDBMS", defaultPort: "3306" },
  { id: "polardb", name: "PolarDB", icon: Server, color: "text-cyan-500", bg: "bg-cyan-500/10", type: "Cloud", defaultPort: "3306" },
  { id: "planetscale", name: "PlanetScale", icon: Server, color: "text-gray-400", bg: "bg-gray-400/10", type: "Cloud", defaultPort: "3306" },

  // --- SQLite Compatible (WORKING) ---
  { id: "sqlite", name: "SQLite", icon: SiSqlite, color: "text-sky-400", bg: "bg-sky-400/10", type: "Embedded" },

  // --- External / Under Development (COMING SOON) ---
  { id: "sqlserver", name: "SQL Server", icon: Database, color: "text-red-500", bg: "bg-red-500/10", type: "RDBMS", defaultPort: "1433", comingSoon: true },
  { id: "oracle", name: "Oracle", icon: GrOracle, color: "text-red-600", bg: "bg-red-600/10", type: "RDBMS", defaultPort: "1521", comingSoon: true },
  { id: "db2", name: "IBM DB2", icon: Database, color: "text-blue-800", bg: "bg-blue-800/10", type: "RDBMS", defaultPort: "50000", comingSoon: true },
  { id: "mongo", name: "MongoDB", icon: SiMongodb, color: "text-green-500", bg: "bg-green-500/10", type: "NoSQL", defaultPort: "27017", comingSoon: true },
  { id: "redis", name: "Redis", icon: SiRedis, color: "text-rose-500", bg: "bg-rose-500/10", type: "NoSQL", defaultPort: "6379", comingSoon: true },
  { id: "elasticsearch", name: "Elasticsearch", icon: Search, color: "text-yellow-500", bg: "bg-yellow-500/10", type: "NoSQL", defaultPort: "9200", comingSoon: true },
  { id: "snowflake", name: "Snowflake", icon: SiSnowflake, color: "text-blue-300", bg: "bg-blue-300/10", type: "Cloud", defaultPort: "443", comingSoon: true },
  { id: "bigquery", name: "BigQuery", icon: Database, color: "text-blue-500", bg: "bg-blue-500/10", type: "Cloud", comingSoon: true },
  { id: "clickhouse", name: "ClickHouse", icon: Database, color: "text-yellow-600", bg: "bg-yellow-600/10", type: "RDBMS", defaultPort: "8123", comingSoon: true },
  { id: "cassandra", name: "Cassandra", icon: SiApachecassandra, color: "text-blue-600", bg: "bg-blue-600/10", type: "NoSQL", defaultPort: "9042", comingSoon: true },
  { id: "dynamodb", name: "DynamoDB", icon: Server, color: "text-blue-500", bg: "bg-blue-500/10", type: "Cloud", comingSoon: true },
  { id: "neo4j", name: "Neo4j", icon: SiNeo4J, color: "text-blue-400", bg: "bg-blue-400/10", type: "Graph", defaultPort: "7687", comingSoon: true },
  { id: "couchbase", name: "Couchbase", icon: SiCouchbase, color: "text-red-500", bg: "bg-red-500/10", type: "NoSQL", defaultPort: "8091", comingSoon: true },
  { id: "firebase", name: "Firebase", icon: SiFirebase, color: "text-yellow-500", bg: "bg-yellow-500/10", type: "Cloud", comingSoon: true },
  { id: "arango", name: "ArangoDB", icon: Database, color: "text-green-500", bg: "bg-green-500/10", type: "Graph", defaultPort: "8529", comingSoon: true },
  { id: "influxdb", name: "InfluxDB", icon: SiInfluxdb, color: "text-purple-500", bg: "bg-purple-500/10", type: "Time-Series", defaultPort: "8086", comingSoon: true },
  { id: "duckdb", name: "DuckDB", icon: SiDuckdb, color: "text-yellow-500", bg: "bg-yellow-500/10", type: "Embedded", comingSoon: true }
];
