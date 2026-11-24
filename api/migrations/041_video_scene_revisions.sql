ALTER TABLE text_video_plans ADD COLUMN repair_from uuid REFERENCES text_video_plans(id);
ALTER TABLE text_video_plans ADD COLUMN repair_scene text;
ALTER TABLE text_video_plans ADD COLUMN repair_benchmark_id uuid REFERENCES video_model_benchmarks(id);
